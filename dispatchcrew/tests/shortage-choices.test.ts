import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest';
import request from 'supertest';
import { Store,seedCatalogue } from '../server/db';
import { Workflow } from '../server/workflow';
import { createApp } from '../server/app';
import type { AIProvider } from '../server/ai';
import type { ManagementOrder,ShortageChoices,ShortageSelection } from '../shared/types';

let store:Store,workflow:Workflow,provider:AIProvider;
const draft=vi.fn(async()=>({summary:'Pick the newly confirmed order.',message:'This is a simulated dispatch. No real shipment was made.'}));
beforeEach(()=>{store=new Store(':memory:');seedCatalogue(store);draft.mockClear();provider={configured:true,source:'test',interpret:vi.fn(),draft};workflow=new Workflow(store,provider);});
afterEach(async()=>{await workflow.drain();store.close();});
async function held(lines:[string,number][]= [['desktop staplers',12],['A4 paper reams',5]]) {
  const message=lines.map(([name,qty])=>`${qty} ${name}`).join(' and ');
  provider.interpret=vi.fn(async()=>({lines:lines.map(([productText,quantity])=>({productText,quantity,evidence:message})),deliveryAddress:null,questions:[],plan:[]}));
  const result=workflow.create({customerId:'acme',reference:'SHORT-001',message});await workflow.idle(result.order.id);
  workflow.confirm(result.order.id,1);await workflow.idle(result.order.id);const order=workflow.management(result.order.id);expect(order.status).toBe('on_hold');return order;
}
function selection(quote:ShortageChoices,productId:string,kind:string):ShortageSelection {
  const issue=quote.issues.find(i=>i.productId===productId)!;
  return {originalProductId:productId,optionId:issue.options.find(o=>o.kind===kind)!.id};
}
function apply(order:ManagementOrder,selections:ShortageSelection[]) {const quote=order.shortageChoices!;workflow.applyShortageChoices(order.id,{version:quote.version,quoteId:quote.quoteId,selections});return workflow.management(order.id);}

describe('shortage choices',()=>{
  it('reduces to current availability, preserves other lines, and requires fresh confirmation without an AI call',async()=>{
    let order=await held();const quote=order.shortageChoices!,reduce=quote.issues[0].options.find(o=>o.kind==='reduce')!;
    expect(reduce.quantity).toBe(4);expect(reduce.total).toBe(88000);expect(reduce.priceDifference).toBe(-176000);
    workflow.reply(order.id,{action:'wait'});order=apply(order,[selection(quote,'stapler','reduce')]);
    expect(order.status).toBe('awaiting_confirmation');expect(order.version).toBe(2);expect(order.total).toBe(263000);expect(order.lines.map(l=>l.quantity)).toEqual([4,5]);expect(order.waitingForStock).toBe(false);
    expect(order.shortageChoices).toBeNull();expect(order.restock).toEqual([]);expect(order.approval).toBeNull();expect(provider.interpret).toHaveBeenCalledTimes(1);expect(draft).not.toHaveBeenCalled();
    expect(store.get('SELECT SUM(reserved) AS n FROM inventory').n).toBe(0);expect(order.revisions).toHaveLength(1);expect(order.revisions[0].before.total).toBe(439000);expect(order.revisions[0].after.total).toBe(263000);
    expect(()=>workflow.confirm(order.id,1)).toThrow('changed');workflow.confirm(order.id,2);await workflow.idle(order.id);order=workflow.management(order.id);expect(order.status).toBe('awaiting_approval');
    workflow.approve(order.id,{approvalId:order.approval!.id,decision:'approve'});await workflow.idle(order.id);expect(workflow.management(order.id).status).toBe('dispatched');expect(store.get("SELECT reserved FROM inventory WHERE product_id='stapler'").reserved).toBe(4);
  });
  it('offers only approved alternatives and shows their price difference',async()=>{
    store.run("UPDATE inventory SET on_hand=10 WHERE product_id='nb-a5'");let order=await held([['A5 notebooks',20]]);const quote=order.shortageChoices!,substitute=quote.issues[0].options.find(o=>o.kind==='substitute')!;
    expect(substitute.productId).toBe('nb-a4');expect(substitute.quantity).toBe(20);expect(substitute.unitPrice).toBe(18000);expect(substitute.priceDifference).toBe(120000);expect(substitute.explanation).toContain('larger');
    order=apply(order,[selection(quote,'nb-a5','substitute')]);expect(order.lines[0].productId).toBe('nb-a4');expect(order.total).toBe(360000);expect(order.revisions[0].before.lines[0].productId).toBe('nb-a5');
  });
  it('groups duplicate product lines before reducing quantities',async()=>{
    store.run("UPDATE inventory SET on_hand=10 WHERE product_id='nb-a5'");let order=await held([['A5 notebooks',20],['A5 notebooks',15]]);expect(order.shortageChoices!.issues[0].requested).toBe(35);
    order=apply(order,[selection(order.shortageChoices!,'nb-a5','reduce')]);expect(order.lines).toHaveLength(1);expect(order.lines[0].quantity).toBe(10);expect(order.total).toBe(120000);
  });
  it.each(['stock','price','policy','order'] as const)('rejects a stale %s quote without changing the order',async change=>{
    const order=await held(),quote=order.shortageChoices!;
    if(change==='stock')workflow.adjustStock('stapler',1);
    if(change==='price')store.run("UPDATE products SET price=23000 WHERE id='stapler'");
    if(change==='policy')store.run("INSERT INTO approved_substitutions VALUES('stapler','folder','Test-approved replacement')");
    if(change==='order')store.run('UPDATE orders SET version=version+1 WHERE id=?',order.id);
    expect(()=>apply(order,[selection(quote,'stapler','reduce')])).toThrow(/changed/);expect(workflow.management(order.id).lines[0].quantity).toBe(12);expect(store.get('SELECT COUNT(*) AS n FROM order_revisions').n).toBe(0);expect(store.get('SELECT SUM(reserved) AS n FROM inventory').n).toBe(0);
  });
  it('deduplicates an identical submission and rejects conflicting reuse of its quote',async()=>{
    const order=await held(),quote=order.shortageChoices!,selections=[selection(quote,'stapler','reduce')];const input={version:quote.version,quoteId:quote.quoteId,selections};
    workflow.applyShortageChoices(order.id,input);workflow.applyShortageChoices(order.id,input);expect(workflow.management(order.id).version).toBe(2);expect(store.get('SELECT COUNT(*) AS n FROM order_revisions').n).toBe(1);
    expect(()=>workflow.applyShortageChoices(order.id,{...input,selections:[selection(quote,'stapler','remove')]})).toThrow('different selections');
  });
  it('rolls the entire revision back if persisting the audit record fails',async()=>{
    const order=await held(),quote=order.shortageChoices!,eventCount=order.events.length;
    store.db.exec("CREATE TRIGGER fail_revision BEFORE INSERT ON order_revisions BEGIN SELECT RAISE(ABORT,'Injected audit failure'); END");
    expect(()=>apply(order,[selection(quote,'stapler','reduce')])).toThrow('Injected audit failure');
    const current=workflow.management(order.id);expect(current.status).toBe('on_hold');expect(current.version).toBe(1);expect(current.total).toBe(order.total);expect(current.lines[0].quantity).toBe(12);expect(current.events).toHaveLength(eventCount);expect(store.get('SELECT COUNT(*) AS n FROM shortage_choice_receipts').n).toBe(0);
  });
  it('invalidates an earlier warehouse proposal and still requires fresh customer consent',async()=>{
    provider.interpret=async()=>({lines:[{productText:'A5 notebooks',quantity:20,evidence:'20 A5 notebooks and 10 black desk organisers'},{productText:'black desk organisers',quantity:10,evidence:'20 A5 notebooks and 10 black desk organisers'}],deliveryAddress:null,questions:[],plan:[]});
    const result=workflow.create({customerId:'acme',reference:'STALE-APPROVAL',message:'20 A5 notebooks and 10 black desk organisers'});await workflow.idle(result.order.id);
    let order=workflow.management(result.order.id);workflow.confirm(order.id,order.version);await workflow.idle(order.id);order=workflow.management(order.id);const oldApproval=order.approval!.id;
    workflow.adjustStock('nb-a5',-110);expect(()=>workflow.approve(order.id,{approvalId:oldApproval,decision:'approve'})).toThrow('Stock changed');
    order=workflow.management(order.id);const oldVersion=order.version;order=apply(order,[selection(order.shortageChoices!,'nb-a5','reduce')]);expect(order.version).toBe(oldVersion+1);expect(order.status).toBe('awaiting_confirmation');
    expect(()=>workflow.approve(order.id,{approvalId:oldApproval,decision:'approve'})).toThrow('no longer current');expect(()=>workflow.confirm(order.id,oldVersion)).toThrow('changed');
  });
  it('allows removing a short line but rejects removing the entire order',async()=>{
    let order=await held();order=apply(order,[selection(order.shortageChoices!,'stapler','remove')]);expect(order.lines).toHaveLength(1);expect(order.lines[0].productId).toBe('paper-a4');expect(order.total).toBe(175000);
    provider.interpret=async()=>({lines:[{productText:'desktop staplers',quantity:12,evidence:'12 desktop staplers'}],deliveryAddress:null,questions:[],plan:[]});const result=workflow.create({customerId:'acme',reference:'ONLY-SHORT',message:'12 desktop staplers'});await workflow.idle(result.order.id);workflow.confirm(result.order.id,1);await workflow.idle(result.order.id);const only=workflow.management(result.order.id);
    expect(()=>apply(only,[selection(only.shortageChoices!,'stapler','remove')])).toThrow('at least one');expect(workflow.management(only.id).status).toBe('on_hold');
  });
  it('rejects forged options, missing issues and duplicate selections',async()=>{
    const order=await held(),quote=order.shortageChoices!,valid=selection(quote,'stapler','reduce');
    expect(()=>apply(order,[{...valid,optionId:'f'.repeat(64)}])).toThrow('offered');expect(()=>apply(order,[])).toThrow('exactly one');expect(()=>apply(order,[valid,valid])).toThrow('exactly one');expect(workflow.management(order.id).version).toBe(1);
  });
  it('does not offer sold-out alternatives or overcommit stock already needed by another line',async()=>{
    store.run("UPDATE inventory SET on_hand=10 WHERE product_id='nb-a5'");store.run("UPDATE inventory SET on_hand=5 WHERE product_id='nb-a4'");
    const order=await held([['A5 notebooks',20],['A4 notebooks',5]]);expect(order.shortageChoices!.issues[0].options.some(o=>o.kind==='substitute')).toBe(false);
  });
  it('rejects combined substitutions that compete for the same inventory',async()=>{
    store.run("UPDATE inventory SET on_hand=1 WHERE product_id IN ('nb-a5','org-black')");
    store.run("INSERT INTO approved_substitutions VALUES('nb-a5','folder','Explicit test policy')");store.run("INSERT INTO approved_substitutions VALUES('org-black','folder','Explicit test policy')");
    const order=await held([['A5 notebooks',80],['black desk organisers',80]]),quote=order.shortageChoices!;
    const selections=quote.issues.map(issue=>({originalProductId:issue.productId,optionId:issue.options.find(o=>o.productId==='folder')!.id}));
    expect(()=>apply(order,selections)).toThrow('compete');expect(store.get('SELECT COUNT(*) AS n FROM shortage_choice_receipts').n).toBe(0);expect(workflow.management(order.id).status).toBe('on_hold');
  });
  it('keeps choices stable across restart and retains the audit receipt',async()=>{
    const order=await held(),quote=order.shortageChoices!;const restarted=new Workflow(store,provider);expect(restarted.shortageChoices(order.id).quoteId).toBe(quote.quoteId);
    const input={version:quote.version,quoteId:quote.quoteId,selections:[selection(quote,'stapler','reduce')]};restarted.applyShortageChoices(order.id,input);new Workflow(store,provider).applyShortageChoices(order.id,input);expect(workflow.management(order.id).revisions).toHaveLength(1);
  });
});
describe('shortage choices HTTP',()=>{
  it('uses the tracking token, returns only customer-safe offers, and validates payloads',async()=>{
    const order=await held(),app=createApp(workflow),url=`/api/track/${order.trackingToken}/shortage-choices`;
    const {body:quote}=await request(app).get(url).expect(200);expect(quote).not.toHaveProperty('reserved');expect(quote).not.toHaveProperty('revisions');expect(JSON.stringify(quote)).not.toContain('onHand');
    await request(app).get('/api/track/invalid/shortage-choices').expect(404);
    const input={version:quote.version,quoteId:quote.quoteId,selections:[selection(quote,'stapler','reduce')]};
    await request(app).post(url).send({...input,total:1}).expect(400);const response=await request(app).post(url).send(input).expect(200);expect(response.body.status).toBe('awaiting_confirmation');expect(response.body).not.toHaveProperty('revisions');
    await request(app).post(url).send(input).expect(200);await request(app).get(url).expect(409);
    const other=workflow.create({customerId:'acme',reference:'OTHER',message:'20 A5 notebooks and 10 black desk organisers'});await workflow.idle(other.order.id);
    await request(app).post(`/api/track/${other.trackingToken}/shortage-choices`).send(input).expect(409);expect(workflow.management(order.id).version).toBe(2);
  });
});
