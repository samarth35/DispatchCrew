import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store } from './db.js';
import { intakeSchema, type AIProvider } from './ai.js';
import { buildShortageChoices, fingerprint, type Substitution } from './shortage-choices.js';
import type { Approval, Customer, CustomerOrder, Intake, Line, ManagementOrder, OrderStatus, OrderSummary, Product, Question, ShortageChoices, ShortageOption, ShortageSelection, StockImpact } from '../shared/types.js';

export class AppError extends Error { constructor(public status: number, message: string,public preserveChanges=false) { super(message); } }
const now = () => new Date().toISOString();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normal = (s: string) => s.toLowerCase().replace(/organizers?/g,'organiser').replace(/organisers/g,'organiser').replace(/notebooks/g,'notebook').replace(/reams/g,'ream').replace(/packs/g,'pack').replace(/folders/g,'folder').replace(/staplers/g,'stapler').replace(/[^a-z0-9]+/g,' ').trim();
const nextActions: Record<OrderStatus,string> = {
  interpreting:'We are reading your order.', needs_clarification:'Answer the questions below so we can finish your order summary.', awaiting_confirmation:'Check the Order Mirror and confirm the items and quantities.',
  preparing:'Your order is confirmed. We are checking stock and preparing it for review.', on_hold:'Some items are short on stock. Review shortage choices below, wait for stock, or revise your order.',
  awaiting_approval:'Your order is with the warehouse team for approval.', dispatching:'The warehouse team approved your order. Simulated dispatch is in progress.',
  dispatched:'Your simulated warehouse dispatch is complete. No courier booking or real shipment has been made.', failed:'The team needs to retry a step. Your order is saved.', interrupted:'Your order is saved. The team can resume processing.', rejected:'The warehouse team could not approve this order. See the update below.',
};
function safeError(error: unknown) {
  if (error instanceof AppError) return error.message;
  if (error instanceof z.ZodError) return 'AI returned an invalid order structure. Review your message and retry.';
  if (error instanceof Error && /^(OPENROUTER_API_KEY is missing|OpenRouter free-only|OpenRouter rejected request|OpenRouter did not return|AI returned no valid|AI could not prepare)/.test(error.message)) return error.message;
  const status = (error as {status?: number})?.status;
  if(status===429) return 'The free model is rate-limited. Your order is saved; retry later. No paid fallback was used.';
  if(status===401) return 'OpenRouter did not accept the configured key. Check OPENROUTER_API_KEY locally and restart the API.';
  if(status===402) return 'OpenRouter declined this free-model request because of account limits. No paid fallback was used.';
  return status ? `The free AI service returned HTTP ${status}. Your order is saved; check free-model availability and retry.` : 'A processing step could not complete. Your order is saved; retry to continue.';
}

export class Workflow {
  private active = new Map<string, Promise<void>>();
  constructor(public store: Store, public ai: AIProvider, public demoControls = true) {}
  async recover(staleOnly=false) {
    const store=this.store;
    await store.transaction(async()=>{await store.run("UPDATE orders SET status='interrupted', error='Processing was interrupted. Resume the saved step.' WHERE status IN ('interpreting','preparing','dispatching')"+(staleOnly?' AND updated_at<?':''),...(staleOnly?[new Date(Date.now()-6*60000).toISOString()]:[]));await store.run("UPDATE runs SET state='interrupted' WHERE state='running' AND order_id IN (SELECT id FROM orders WHERE status='interrupted')");await store.run("UPDATE tasks SET state='interrupted' WHERE state='running' AND run_id IN (SELECT id FROM runs WHERE state='interrupted')");});
  }
  async row(id: string) { const row = (await this.store.get('SELECT * FROM orders WHERE id=?',id)); if (!row) throw new AppError(404,'Order not found.'); return row; }
  async byToken(token: string) { const row = (await this.store.get('SELECT id FROM orders WHERE token=?',token)); if (!row) throw new AppError(404,'Tracking link not found.'); return row.id as string; }
  private async update(id: string, fields: Record<string, string|number|null>) {
    const entries = Object.entries({...fields, updated_at: now()});
    (await this.store.run(`UPDATE orders SET ${entries.map(([k])=>`${k}=?`).join(',')} WHERE id=?`,...entries.map(([,v])=>v),id));
  }
  async event(id: string, role: string, title: string, detail = '', visibility: 'customer'|'internal'='internal') {
    (await this.store.run('INSERT INTO events(order_id,role,title,detail,visibility,at) VALUES(?,?,?,?,?,?)',id,role,title,detail,visibility,now()));
  }
  private async runState(id: string, state: string, stage: string) { (await this.store.run('UPDATE runs SET state=?,stage=? WHERE order_id=?',state,stage,id)); }
  private async task(id: string, role: string, title: string, state: string, output: unknown = null) {
    const run = (await this.store.get('SELECT id FROM runs WHERE order_id=?',id));
    (await this.store.run(`INSERT INTO tasks(id,run_id,role,title,state,attempts,output) VALUES(?,?,?,?,?,1,?) ON CONFLICT(run_id,role,title) DO UPDATE SET state=excluded.state, attempts=tasks.attempts+CASE WHEN excluded.state='running' THEN 1 ELSE 0 END, output=excluded.output`,randomUUID(),run.id,role,title,state,JSON.stringify(output)));
  }
  private async launch(id: string, stage: string, fn: () => Promise<void>) {
    if (this.active.has(id)) throw new AppError(409,'This order is already processing.');
    (await this.runState(id,'running',stage));
    this.store.afterCommit(()=>{
    const promise = Promise.resolve().then(fn).catch(async error => {
      const message = safeError(error);
      (await this.update(id,{status:'failed',error:message,failure_stage:stage}));
      (await this.runState(id,'failed',stage));
      (await this.store.run("UPDATE tasks SET state='failed' WHERE run_id=(SELECT id FROM runs WHERE order_id=?) AND state='running'",id));
      (await this.event(id,'Supervisor','Step needs a retry',message,'customer'));
    }).finally(()=>this.active.delete(id));
    this.active.set(id,promise);
    });
  }
  async idle(id: string) { await this.active.get(id); }
  async drain() { await Promise.all(this.active.values()); }
  async create(input: { customerId: string; reference: string; message: string }) {return this.store.transaction(async()=>{
    const customer = (await this.store.get<Customer>('SELECT * FROM customers WHERE id=?',input.customerId));
    if (!customer) throw new AppError(400,'Choose a known customer.');
    const fingerprint = hash({customer:input.customerId,message:input.message.trim()});
    const existing = (await this.store.get('SELECT * FROM orders WHERE customer_id=? AND reference=?',input.customerId,input.reference));
    if (existing) {
      if (existing.input_hash !== fingerprint) throw new AppError(409,'This order reference already exists with different contents. Use a new reference.');
      return {order:(await this.customer(existing.id)),trackingToken:existing.token,replayed:true};
    }
    const id = randomUUID(), token = randomUUID()+randomUUID(), date = now();
    (await this.store.transaction(async ()=>{
      (await this.store.run('INSERT INTO orders(id,reference,customer_id,input_hash,message,address,token,status,ai_source,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',id,input.reference,input.customerId,fingerprint,input.message.trim(),customer.address,token,'interpreting',this.ai.source,date,date));
      (await this.store.run('INSERT INTO runs VALUES(?,?,?,?)',randomUUID(),id,'queued','intake'));
      (await this.event(id,'Customer','Order received','Your request is saved.','customer'));
    }));
    (await this.launch(id,'intake',async ()=>(await this.interpret(id))));
    return {order:(await this.customer(id)),trackingToken:token,replayed:false};
  });}
  private candidates(text: string, catalogue: Product[]) {
    const term = normal(text);
    const exact = catalogue.filter(p=>normal(p.name)===term||p.aliases.some(a=>normal(a)===term));
    if (exact.length) return exact;
    const matches = catalogue.map(p=>({p,score:Math.max(0,...p.aliases.filter(a=>(' '+term+' ').includes(' '+normal(a)+' ')).map(a=>normal(a).length))}));
    const max = Math.max(0,...matches.map(m=>m.score));
    return max ? matches.filter(m=>m.score===max).map(m=>m.p) : [];
  }
  private async interpret(id: string) {
    (await this.task(id,'Intake & planner','Interpret request','running'));
    (await this.event(id,'Intake & planner','Reading the order','Matching the request to the product catalogue.'));
    const row = (await this.row(id)), customer = (await this.store.get<Customer>('SELECT * FROM customers WHERE id=?',row.customer_id))!;
    const intake = intakeSchema.parse(await this.ai.interpret(row.message,customer,(await this.store.products())));
    if (!intake.lines.length || intake.lines.length>30) throw new AppError(422,'Please provide between 1 and 30 order lines.');
    for (const line of intake.lines) {
      if (!line.evidence || !row.message.includes(line.evidence) || !normal(line.evidence).includes(normal(line.productText))) throw new AppError(422,'AI could not ground an item in your message. Please use the catalogue product names and retry.');
      if (line.quantity !== null && (!Number.isSafeInteger(line.quantity)||line.quantity<=0||line.quantity>10000)) throw new AppError(422,'Quantities must be whole numbers between 1 and 10,000. Please revise your order.');
    }
    (await this.applyIntake(id,intake));
    (await this.task(id,'Intake & planner','Interpret request','completed',{plan:intake.plan,lines:intake.lines}));
  }
  private async applyIntake(id: string, intake: Intake, overrides: Record<string,string> = {}) {
    const catalogue = (await this.store.products()), questions: Question[] = [], lines: Line[]=[];
    intake.lines.forEach((line,index)=>{
      const candidates = this.candidates(line.productText,catalogue);
      let product = candidates.length===1 ? candidates[0] : undefined;
      const selected = overrides[`product:${index}`];
      if (selected) {
        product = catalogue.find(p=>p.id===selected);
        if (!product) throw new AppError(400,'Choose a catalogue product.');
        if (candidates.length && !candidates.some(p=>p.id===selected)) throw new AppError(400,'Choose one of the matching products.');
      }
      let quantity = line.quantity;
      if (overrides[`quantity:${index}`]) quantity = z.coerce.number().int().min(1).max(10000).parse(overrides[`quantity:${index}`]);
      if (!product) questions.push({id:`product:${index}`,kind:'product',lineIndex:index,label:`Which product did you mean by “${line.productText}”?`,options:(candidates.length?candidates:catalogue).map(p=>({value:p.id,label:p.name}))});
      if (quantity===null) questions.push({id:`quantity:${index}`,kind:'quantity',lineIndex:index,label:`How many ${product?.name || line.productText} do you need?`,options:[]});
      lines.push({index,productId:product?.id||null,name:product?.name||line.productText,quantity,unitPrice:product?.price||0,total:quantity&&product?quantity*product.price:0});
    });
    intake.questions.forEach((q,i)=>{ if (!overrides[`details:${i}`]&&!questions.some(existing=>existing.label===q)) questions.push({id:`details:${i}`,kind:'details',lineIndex:null,label:q,options:[]}); });
    const row=(await this.row(id)), complete=questions.length===0;
    (await this.store.transaction(async ()=>{
      (await this.store.run('DELETE FROM lines WHERE order_id=?',id));
      for(const line of lines) (await this.store.run('INSERT INTO lines VALUES(?,?,?,?,?,?)',id,line.index,line.productId,line.name,line.quantity,line.unitPrice));
      (await this.update(id,{status:complete?'awaiting_confirmation':'needs_clarification',questions:JSON.stringify(questions),intake:JSON.stringify({...intake,overrides}),address:intake.deliveryAddress?.trim()||row.address,total:lines.reduce((sum,l)=>sum+l.total,0),error:null,failure_stage:null}));
      (await this.runState(id,complete?'waiting_customer':'waiting_input','intake'));
      (await this.event(id,'Intake & planner',complete?'Order Mirror ready':'A few details needed',complete?'Review the items and quantities before confirming.':questions.map(q=>q.label).join(' '),'customer'));
    }));
  }
  async reply(id: string, input: {action:'clarify'|'revise'|'wait';answers?:Record<string,string>;message?:string}) {return this.store.transaction(async()=>{
    const row=(await this.row(id));
    if (this.active.has(id)) throw new AppError(409,'Wait for the current step to finish.');
    if(input.action==='wait') {
      if(row.status!=='on_hold') throw new AppError(409,'Only an order on stock hold can wait for stock.');
      if(!row.waiting_stock) (await this.event(id,'Customer','Waiting for stock','You chose to keep the whole order on hold.','customer'));
      (await this.update(id,{waiting_stock:1}));return;
    }
    if(input.action==='revise') {
      if(!['needs_clarification','awaiting_confirmation','awaiting_approval','on_hold','failed','rejected','interrupted'].includes(row.status)) throw new AppError(409,'This order cannot be revised at this stage.');
      if(!input.message?.trim()) throw new AppError(400,'Enter the full revised order.');
      (await this.store.transaction(async ()=>{
        (await this.store.run("UPDATE approvals SET decision='invalidated' WHERE order_id=? AND decision IN ('pending','approved')",id));
        (await this.update(id,{message:input.message!.trim(),version:row.version+1,status:'interpreting',error:null,failure_stage:null,waiting_stock:0,restock:'[]',questions:'[]'}));
        (await this.store.run('DELETE FROM lines WHERE order_id=?',id));
        (await this.update(id,{total:0}));
        (await this.event(id,'Customer','Order revised','A fresh summary and approval will be required.','customer'));
      }));
      (await this.launch(id,'intake',async ()=>(await this.interpret(id))));return;
    }
    if(row.status!=='needs_clarification') throw new AppError(409,'This order is not waiting for clarification.');
    const intake=JSON.parse(row.intake) as Intake & {overrides?:Record<string,string>};
    const questions=JSON.parse(row.questions) as Question[];
    const answers=input.answers||{};
    if(!Object.keys(answers).length) throw new AppError(400,'Answer at least one question.');
    if(Object.keys(answers).some(key=>!questions.some(q=>q.id===key))) throw new AppError(400,'One of these questions is no longer active. Refresh your order.');
    const overrides={...intake.overrides,...answers};
    (await this.store.transaction(async ()=>{
      (await this.update(id,{version:row.version+1}));
      (await this.event(id,'Customer','Details received','Your answers are attached to this order.','customer'));
      (await this.applyIntake(id,intake,overrides));
    }));
  });}
  private async lines(id:string):Promise<Line[]> { return (await this.store.all(`SELECT l.line_index AS 'index',l.product_id AS productId,l.name,l.quantity,l.unit_price AS unitPrice,COALESCE(l.quantity,0)*l.unit_price AS total, i.on_hand-i.reserved AS available FROM lines l LEFT JOIN inventory i ON i.product_id=l.product_id WHERE l.order_id=? ORDER BY l.line_index`,id)); }
  async shortageChoices(id: string): Promise<ShortageChoices> {
    const row = (await this.row(id));
    if (row.status !== 'on_hold') throw new AppError(409, 'Shortage choices are available only while this order is on stock hold.');
    return buildShortageChoices(id, row.version, (await this.lines(id)), (await this.store.products()), (await this.store.all<Substitution>('SELECT product_id AS productId,replacement_id AS replacementId,reason FROM approved_substitutions')));
  }
  async applyShortageChoices(id: string, input: {version: number; quoteId: string; selections: ShortageSelection[]}) {return this.store.transaction(async()=>{
    const selections = [...input.selections].sort((a,b)=>a.originalProductId.localeCompare(b.originalProductId));
    const requestHash = fingerprint({version:input.version,selections});
    const receipt = (await this.store.get('SELECT request_hash FROM shortage_choice_receipts WHERE order_id=? AND quote_id=?',id,input.quoteId));
    if (receipt) {
      if (receipt.request_hash !== requestHash) throw new AppError(409, 'These shortage choices were already applied with different selections. Review the current order.');
      return;
    }
    if (this.active.has(id)) throw new AppError(409, 'Wait for the current step to finish.');
    (await this.store.transaction(async ()=>{
      const row = (await this.row(id));
      if (row.version !== input.version) throw new AppError(409, 'The order has changed. Review the latest shortage choices.');
      const quote = (await this.shortageChoices(id));
      if (quote.quoteId !== input.quoteId) throw new AppError(409, 'Stock, prices or approved alternatives changed. Review the refreshed choices.');
      if (!quote.issues.length) throw new AppError(409, 'This order no longer has a shortage. Ask the warehouse team to recheck stock.');
      if (new Set(selections.map(s=>s.originalProductId)).size !== selections.length || selections.length !== quote.issues.length) throw new AppError(400, 'Choose exactly one option for each short product.');
      const selected = new Map<string, ShortageOption>();
      for (const selection of selections) {
        const issue = quote.issues.find(issue=>issue.productId===selection.originalProductId);
        const option = issue?.options.find(option=>option.id===selection.optionId);
        if (!option) throw new AppError(400, 'Choose one of the offered, approved shortage options.');
        selected.set(selection.originalProductId,option);
      }
      const oldLines = (await this.lines(id)), nextLines: Line[] = [], handled = new Set<string>();
      for (const line of oldLines) {
        const option = line.productId ? selected.get(line.productId) : undefined;
        if (!option) { const {available,...safeLine}=line; nextLines.push({...safeLine,index:nextLines.length}); continue; }
        if (handled.has(line.productId!)) continue;
        handled.add(line.productId!);
        if (option.productId && option.quantity) nextLines.push({index:nextLines.length,productId:option.productId,name:option.name,quantity:option.quantity,unitPrice:option.unitPrice,total:option.total});
      }
      if (!nextLines.length) throw new AppError(400, 'An order must keep at least one product. Choose a reduction, an alternative, or wait for stock.');
      const products = new Map((await this.store.products()).map(p=>[p.id,p]));
      const demands = new Map<string,number>();
      for (const line of nextLines) demands.set(line.productId!, (demands.get(line.productId!)||0)+line.quantity!);
      for (const [productId,quantity] of demands) if ((products.get(productId)?.available ?? -1) < quantity) throw new AppError(409, 'These choices compete for the same stock. Choose a different combination or wait for stock.');
      const total = nextLines.reduce((sum,line)=>sum+line.total,0);
      const message = nextLines.map(line=>`${line.quantity} ${line.name}`).join(' and ');
      const before = {lines:oldLines.map(({available,...line})=>line),total:row.total,message:row.message};
      const after = {lines:nextLines,total,message};
      (await this.store.run("UPDATE approvals SET decision='invalidated' WHERE order_id=? AND decision IN ('pending','approved')",id));
      (await this.store.run('DELETE FROM lines WHERE order_id=?',id));
      for (const line of nextLines) (await this.store.run('INSERT INTO lines VALUES(?,?,?,?,?,?)',id,line.index,line.productId,line.name,line.quantity,line.unitPrice));
      const canonical: Intake = {lines:nextLines.map(line=>({productText:line.name,quantity:line.quantity,evidence:message})),deliveryAddress:row.address,questions:[],plan:['customer_confirmation','check_inventory','prepare_fulfilment','manager_approval','dispatch']};
      (await this.update(id,{status:'awaiting_confirmation',version:row.version+1,total,message,intake:JSON.stringify(canonical),questions:'[]',restock:'[]',waiting_stock:0,error:null,failure_stage:null,faults_remaining:0}));
      (await this.store.run('INSERT INTO order_revisions VALUES(?,?,?,?,?,?,?,?)',randomUUID(),id,row.version,row.version+1,'shortage_choices',JSON.stringify(before),JSON.stringify(after),now()));
      (await this.store.run('INSERT INTO shortage_choice_receipts VALUES(?,?,?,?)',id,input.quoteId,requestHash,row.version+1));
      (await this.runState(id,'waiting_customer','prepare'));
      (await this.task(id,'Customer','Resolve stock shortage','completed',{fromVersion:row.version,toVersion:row.version+1,selections}));
      (await this.event(id,'Customer','Shortage choices applied',quote.issues.map(issue=>{const option=selected.get(issue.productId)!;return `${issue.requested} ${issue.name} → ${option.quantity} ${option.kind==='remove'?'units (removed)':option.name}.`;}).join(' ')+' Review the new Order Mirror and confirm again. No stock has been reserved.','customer'));
    }));
  });}
  private async impact(id:string):Promise<StockImpact[]> {
    return (await this.store.all(`SELECT p.id AS productId,p.name,SUM(l.quantity) AS quantity,i.on_hand AS onHand,i.reserved,i.on_hand-i.reserved AS available,i.on_hand-i.reserved-SUM(l.quantity) AS after,p.price AS unitPrice FROM lines l JOIN products p ON p.id=l.product_id JOIN inventory i ON i.product_id=p.id WHERE l.order_id=? GROUP BY p.id`,id));
  }
  async confirm(id:string,version:number) {return this.store.transaction(async()=>{
    const row=(await this.row(id));
    if(row.version!==version) throw new AppError(409,'The order summary has changed. Review the latest version.');
    if(row.status!=='awaiting_confirmation') {
      if(['preparing','on_hold','awaiting_approval','dispatching','dispatched'].includes(row.status)) return;
      throw new AppError(409,'Resolve the order details before confirming.');
    }
    (await this.update(id,{status:'preparing'}));
    (await this.event(id,'Customer','Order confirmed','The items, quantities and total have been confirmed.','customer'));
    (await this.task(id,'Customer','Confirm Order Mirror','completed',{version}));
    (await this.launch(id,'prepare',async ()=>(await this.prepare(id))));
  });}
  private async setHold(id:string,impact:StockImpact[]) {
    const shortages=impact.filter(i=>i.after<0).map(i=>({name:i.name,requested:i.quantity,available:i.available,shortage:-i.after}));
    (await this.update(id,{status:'on_hold',restock:JSON.stringify(shortages),error:null,failure_stage:null}));
    (await this.runState(id,'held','prepare'));
    (await this.task(id,'Inventory worker','Check inventory','completed',{shortages}));
    (await this.event(id,'Inventory worker','Order on stock hold',shortages.map(s=>`${s.name}: ${s.shortage} more needed.`).join(' ')+' No stock has been reserved.','customer'));
  }
  private async saveApproval(id:string,impact:StockImpact[],draft:{summary:string;message:string}) {
    const row=(await this.row(id)), approvalId=randomUUID();
    const approval:Approval={id:approvalId,decision:'pending',version:row.version,impact,message:draft.message,summary:draft.summary,total:row.total,address:row.address};
    (await this.store.transaction(async ()=>{
      (await this.store.run("UPDATE approvals SET decision='invalidated' WHERE order_id=? AND decision IN ('pending','approved')",id));
      (await this.store.run('INSERT INTO approvals(id,order_id,version,snapshot,at) VALUES(?,?,?,?,?)',approvalId,id,row.version,JSON.stringify(approval),now()));
      (await this.update(id,{status:'awaiting_approval',restock:'[]',error:null,failure_stage:null}));
      (await this.runState(id,'waiting_approval','commit'));
      (await this.event(id,'Supervisor','Ready for warehouse approval','Stock is available. The warehouse team is reviewing your order.','customer'));
    }));
  }
  private async prepare(id:string) {
    (await this.task(id,'Inventory worker','Check inventory','running'));
    const impact=(await this.impact(id));
    if(!impact.length||(await this.lines(id)).some(l=>!l.productId||!l.quantity)) throw new AppError(409,'Order lines are incomplete. Revise and confirm the order.');
    if(impact.some(i=>i.after<0)) {(await this.setHold(id,impact));return;}
    (await this.task(id,'Inventory worker','Check inventory','completed',{impact}));
    (await this.event(id,'Inventory worker','Inventory verified','Whole-order stock is available; nothing reserved yet.'));
    (await this.task(id,'Fulfilment coordinator','Prepare fulfilment','running'));
    const row=(await this.row(id));
    const draft=await this.ai.draft({customer:(await this.store.get('SELECT name FROM customers WHERE id=?',row.customer_id))?.name,address:row.address,lines:(await this.lines(id)).map(({name,quantity,total})=>({name,quantity,totalPaise:total})),totalPaise:row.total,simulation:true});
    if(!draft.message?.trim()||!draft.summary?.trim()||draft.message.length>3000) throw new AppError(422,'AI could not prepare a valid fulfilment message. Retry to continue.');
    (await this.task(id,'Fulfilment coordinator','Prepare fulfilment','completed',draft));
    const freshImpact = (await this.impact(id));
    if (freshImpact.some(i=>i.after<0)) { (await this.setHold(id,freshImpact)); return; }
    (await this.saveApproval(id,freshImpact,draft));
  }
  private async approval(id:string) {
    const row=(await this.store.get("SELECT * FROM approvals WHERE order_id=? AND decision IN ('pending','approved') ORDER BY at DESC,id DESC LIMIT 1",id));
    return row ? {...JSON.parse(row.snapshot),decision:row.decision} as Approval : null;
  }
  async approve(id:string,input:{approvalId:string;decision:'approve'|'reject';reason?:string}) {return this.store.transaction(async()=>{
    const row=(await this.row(id)),record=(await this.store.get('SELECT * FROM approvals WHERE id=? AND order_id=?',input.approvalId,id));
    if(!record) throw new AppError(409,'Approval not found. Refresh the current proposal.');
    if(record.decision==='approved'&&['dispatched','dispatching','failed','interrupted'].includes(row.status)) {
      if(input.decision!=='approve') throw new AppError(409,'This action has already been approved.');return;
    }
    if(record.decision==='rejected'&&input.decision==='reject') return;
    if(row.status!=='awaiting_approval'||record.decision!=='pending'||row.version!==record.version) throw new AppError(409,'This approval is no longer current. Refresh the proposal.');
    const snapshot=JSON.parse(record.snapshot) as Approval;
    if(input.decision==='reject') {
      const reason=input.reason?.trim(); if(!reason) throw new AppError(400,'Add a reason so the customer knows what happened.');
      (await this.store.transaction(async ()=>{(await this.store.run("UPDATE approvals SET decision='rejected',reason=? WHERE id=?",reason,record.id));(await this.update(id,{status:'rejected'}));(await this.runState(id,'rejected','commit'));(await this.event(id,'Warehouse team','Order not approved',reason,'customer'));}));return;
    }
    const current=(await this.impact(id));
    if(hash(current)!==hash(snapshot.impact)) {
      (await this.store.run("UPDATE approvals SET decision='invalidated' WHERE id=?",record.id));
      (await this.event(id,'Supervisor','Stock changed since review','The previous approval was invalidated. Review the new stock impact.'));
      if(current.some(i=>i.after<0)) (await this.setHold(id,current)); else (await this.saveApproval(id,current,{summary:snapshot.summary,message:snapshot.message}));
      throw new AppError(409,'Stock changed. Review the refreshed proposal before approving.',true);
    }
    (await this.store.run("UPDATE approvals SET decision='approved' WHERE id=?",record.id));
    (await this.update(id,{status:'dispatching'}));
    (await this.event(id,'Warehouse team','Warehouse approval received','The approved simulated dispatch is being prepared.','customer'));
    (await this.launch(id,'commit',async ()=>(await this.commit(id,input.approvalId))));
  });}
  private async commit(id:string,approvalId:string) {
    const record=(await this.store.get('SELECT * FROM approvals WHERE id=? AND order_id=?',approvalId,id));
    if(!record||record.decision!=='approved') throw new AppError(409,'A current approval is required.');
    const snapshot=JSON.parse(record.snapshot) as Approval, key=`dispatch:${id}:${approvalId}`;
    (await this.task(id,'Supervisor','Commit simulated dispatch','running'));
    for(let attempt=1;attempt<=3;attempt++) {
      const row=(await this.row(id)),current=(await this.impact(id));
      if(row.status==='dispatched') return;
      if(row.version!==snapshot.version) throw new AppError(409,'The approved order has changed. A new approval is required.');
      if(hash(current)!==hash(snapshot.impact)) {
        (await this.store.run("UPDATE approvals SET decision='invalidated' WHERE id=?",approvalId));
        if(current.some(i=>i.after<0)) (await this.setHold(id,current)); else (await this.saveApproval(id,current,{summary:snapshot.summary,message:snapshot.message}));
        (await this.event(id,'Supervisor','Fresh approval required','Stock changed before commit. No stock was reserved.'));return;
      }
      const inject=row.faults_remaining>0;
      if(inject) (await this.store.run('UPDATE orders SET faults_remaining=faults_remaining-1 WHERE id=?',id));
      try {
        (await this.store.transaction(async ()=>{
          if((await this.store.get('SELECT id FROM dispatches WHERE execution_key=?',key))) return;
          const lockedOrder=await this.row(id),lockedImpact=await this.impact(id);
          if(lockedOrder.version!==snapshot.version)throw new AppError(409,'The approved order changed before commit.');
          if(hash(lockedImpact)!==hash(snapshot.impact)){await this.store.run("UPDATE approvals SET decision='invalidated' WHERE id=?",approvalId);if(lockedImpact.some(i=>i.after<0))await this.setHold(id,lockedImpact);else await this.saveApproval(id,lockedImpact,{summary:snapshot.summary,message:snapshot.message});await this.task(id,'Supervisor','Commit simulated dispatch','completed',{proposalInvalidated:true});await this.event(id,'Supervisor','Fresh approval required','Stock changed inside the commit check. No stock was reserved.');return;}
          for(const item of current) {
            const changed=(await this.store.run('UPDATE inventory SET reserved=reserved+? WHERE product_id=? AND on_hand-reserved>=?',item.quantity,item.productId,item.quantity));
            if(changed.changes!==1) throw new AppError(409,'Stock changed before commit. Refresh approval.');
            (await this.store.run('INSERT INTO reservations VALUES(?,?,?,?)',key,item.productId,id,item.quantity));
          }
          const at=now();
          (await this.store.run('INSERT INTO dispatches VALUES(?,?,?,?,?)',randomUUID(),id,key,`SIM-${row.reference}`,at));
          if(inject) throw new Error('Injected transient tool failure');
          (await this.store.run('INSERT INTO messages VALUES(?,?,?,?,?)',randomUUID(),id,key,snapshot.message,at));
          (await this.update(id,{status:'dispatched',error:null,failure_stage:null}));
          (await this.runState(id,'completed','commit'));
          (await this.task(id,'Supervisor','Commit simulated dispatch','completed',{executionKey:key,attempt}));
          (await this.event(id,'Warehouse team','Simulated dispatch complete',`Reference SIM-${row.reference}. Your order has been reserved and recorded in the simulated warehouse. No real shipment was made.`,'customer'));
        }));return;
      } catch(error) {
        (await this.event(id,'Supervisor',`Dispatch attempt ${attempt} rolled back`,'No partial stock or dispatch changes were kept.'));
        if(!inject||attempt===3) throw new AppError(503,'Dispatch tool failed after three attempts. All stock changes were rolled back. Retry the saved approved action.');
        await new Promise(resolve=>setTimeout(resolve,attempt*150));
      }
    }
  }
  async resume(runId:string) {return this.store.transaction(async()=>{
    const run=(await this.store.get('SELECT * FROM runs WHERE id=?',runId));if(!run) throw new AppError(404,'Run not found.');
    const row=(await this.row(run.order_id));
    if(row.status==='dispatched') return;
    if(!['failed','interrupted','on_hold'].includes(row.status)) throw new AppError(409,'This run is not eligible to resume.');
    const stage=row.failure_stage||run.stage;
    (await this.update(row.id,{status:stage==='intake'?'interpreting':stage==='commit'?'dispatching':'preparing',error:null}));
    (await this.event(row.id,'Supervisor','Processing resumed','Continuing from the saved step.','customer'));
    if(stage==='intake') (await this.launch(row.id,'intake',async ()=>(await this.interpret(row.id))));
    else if(stage==='commit') {
      const approval=(await this.approval(row.id));
      if(!approval||approval.decision!=='approved') throw new AppError(409,'No approved dispatch is available to retry.');
      (await this.launch(row.id,'commit',async ()=>(await this.commit(row.id,approval.id))));
    } else (await this.launch(row.id,'prepare',async ()=>(await this.prepare(row.id))));
  });}
  async injectFault(id:string,count:number) {return this.store.transaction(async()=>{
    if(!this.demoControls) throw new AppError(404,'Demo controls are disabled.');
    if((await this.row(id)).status!=='awaiting_approval') throw new AppError(409,'Inject a failure before approving an order.');
    (await this.update(id,{faults_remaining:count}));(await this.event(id,'Demo control','Recovery test armed',`${count} dispatch attempts will fail inside the transaction.`));
  });}
  async adjustStock(productId:string,delta:number) {return this.store.transaction(async()=>{
    const changed=(await this.store.run('UPDATE inventory SET on_hand=on_hand+? WHERE product_id=? AND on_hand+?>=reserved',delta,productId,delta));
    if(changed.changes!==1) throw new AppError(409,'Stock cannot fall below existing reservations.');
  });}
  async summaries():Promise<OrderSummary[]> {
    return (await this.store.all(`SELECT o.id,o.reference,c.name AS customer,o.status,o.total,o.created_at AS createdAt,o.updated_at AS updatedAt,o.ai_source AS aiSource,(SELECT COUNT(*) FROM lines WHERE order_id=o.id) AS lineCount,(SELECT GROUP_CONCAT(name, ', ') FROM lines WHERE order_id=o.id) AS products FROM orders o JOIN customers c ON c.id=o.customer_id ORDER BY o.created_at DESC`));
  }
  async customer(id:string):Promise<CustomerOrder> {
    const row=(await this.row(id)),lines=(await this.lines(id)).map(({available,...line})=>line);
    const events=(await this.store.all("SELECT id,role,title,detail,at,visibility FROM events WHERE order_id=? AND visibility='customer' ORDER BY id",id));
    const dispatch=(await this.store.get('SELECT reference,at FROM dispatches WHERE order_id=?',id));
    return {id:row.id,reference:row.reference,customer:(await this.store.get<Customer>('SELECT * FROM customers WHERE id=?',row.customer_id))!,status:row.status,version:row.version,message:row.message,address:row.address,lines,questions:JSON.parse(row.questions),total:row.total,createdAt:row.created_at,updatedAt:row.updated_at,timeline:events,dispatch:dispatch?{...dispatch,simulated:true}:null,nextAction:nextActions[row.status as OrderStatus],error:['failed','interrupted'].includes(row.status)?'Processing is paused. The warehouse team can retry your saved order.':null,waitingForStock:Boolean(row.waiting_stock),shortageChoices:row.status==='on_hold'?(await this.shortageChoices(id)):null};
  }
  async management(id:string):Promise<ManagementOrder> {
    const row=(await this.row(id)),run=(await this.store.get('SELECT * FROM runs WHERE order_id=?',id))!;
    return {...(await this.customer(id)),lines:(await this.lines(id)),error:row.error,runId:run.id,trackingToken:row.token,approval:(await this.approval(id)),events:(await this.store.all('SELECT id,role,title,detail,at,visibility FROM events WHERE order_id=? ORDER BY id',id)),tasks:(await this.store.all('SELECT id,role,title,state,attempts,output FROM tasks WHERE run_id=? ORDER BY rowid',run.id)).map(t=>({...t,output:JSON.parse(t.output)})),restock:JSON.parse(row.restock),sentMessages:(await this.store.all('SELECT body,at FROM messages WHERE order_id=?',id)).map(m=>({...m,simulated:true})),failureStage:row.failure_stage,faultsRemaining:row.faults_remaining,aiSource:row.ai_source,revisions:(await this.store.all('SELECT from_version AS fromVersion,to_version AS toVersion,kind,before_json,after_json,at FROM order_revisions WHERE order_id=? ORDER BY to_version',id)).map(r=>({fromVersion:r.fromVersion,toVersion:r.toVersion,kind:r.kind,before:JSON.parse(r.before_json),after:JSON.parse(r.after_json),at:r.at}))};
  }
}
