import express from 'express';
import {randomBytes,createHash} from 'node:crypto';
import {Store} from './db.js';
import {seedExamples} from './seed.js';
import {Workflow,AppError} from './workflow.js';
import {AuthService,hashPassword} from './auth.js';
import {BillingService} from './billing.js';
import {registerRoutes} from './routes.js';
import type {AIProvider} from './ai.js';

export const scriptedDemoProvider:AIProvider={configured:true,source:'demo-scripted',model:'Scripted demo · no model credits',async interpret(message){
  const text=message.trim();const parts=text.replace(/^(we need|please send|we want|i need)\s+/i,'').split(/\s+and\s+|,|\n/).map(s=>s.trim()).filter(Boolean);
  return {lines:parts.map(part=>{const match=part.match(/^(\d+)\s+(.+?)[.!]?$/);return {productText:match?match[2]:part,quantity:match?Number(match[1]):null,evidence:part};}),deliveryAddress:null,questions:[],plan:['resolve_products','customer_confirmation','check_inventory','prepare_fulfilment','manager_approval','dispatch']};
},async draft(facts:any){return {summary:`Pick ${facts.lines.map((l:any)=>`${l.quantity} × ${l.name}`).join(', ')}. Check quantities at handoff.`,message:`Simulated dispatch recorded for ${facts.lines.map((l:any)=>`${l.quantity} × ${l.name}`).join(', ')}. No real shipment has been made.`};}};

let template:Promise<{table:string;rows:any[]}[]>|null=null;
let demoPassword:Promise<string>|null=null;
async function demoTemplate(){const sample=new Store(':memory:');try{await seedExamples(sample);const tables=['customers','products','inventory','approved_substitutions','orders','lines','runs','tasks','events','approvals','reservations','dispatches','messages'];return await Promise.all(tables.map(async table=>({table,rows:await sample.all('SELECT * FROM '+table)})));}finally{await sample.close();}}
async function seedDemo(store:Store){const data=await(template??=demoTemplate());await store.transaction(async()=>{for(const {table,rows} of data)if(rows.length)await store.run(`INSERT INTO ${table} SELECT * FROM json_populate_recordset(NULL::${table},?::json)`,JSON.stringify(rows));await store.exec(`SELECT setval(pg_get_serial_sequence('"${store.schema}".events','id'),(SELECT MAX(id) FROM "${store.schema}".events),true)`);});}

export function demoGateway(main:Store,onBackground:(promise:Promise<unknown>)=>void,ai:AIProvider){
  const cache=new Map<string,{app:express.Express;workflow:Workflow}>();
  const rate=new AuthService(main,new BillingService(main));
  let prepared:Promise<unknown>|null=null;
  return async(req:express.Request,res:express.Response,next:express.NextFunction)=>{try{
    prepared??=main.exec('CREATE TABLE IF NOT EXISTS public.alphaq_demo_workspaces(token_hash TEXT PRIMARY KEY,schema_name TEXT UNIQUE NOT NULL,created_at BIGINT NOT NULL,expires_at BIGINT NOT NULL)');await prepared;
    const raw=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('aq_demo_workspace='))?.split('=')[1];
    const token=raw&&/^[a-f0-9]{48}$/.test(raw)?raw:null;
    let record=token?await main.get('SELECT * FROM public.alphaq_demo_workspaces WHERE token_hash=? AND expires_at>?',createHash('sha256').update(token).digest('hex'),Date.now()):null;
    if(!record){
      if(req.method!=='POST'||!['/auth/demo','/auth/login'].includes(req.path)){if(req.path==='/auth/me'){res.json({user:null,csrfToken:null,setupRequired:false,businessName:'AlphaQ demo',customerSignup:false,demo:true});return;}throw new AppError(401,'Open a demo account to continue.');}
      if(req.path==='/auth/demo'&&!['owner','manager','staff','customer'].includes(req.body?.role))throw new AppError(400,'Choose a valid demo role.');
      if(req.path==='/auth/login'&&(!/^(owner|manager|staff|customer)@demo\.alphaq\.example$/.test(req.body?.email||'')||req.body?.password!=='AlphaQ demo access 2026!'))throw new AppError(401,'Demo email or password is incorrect.');
      await rate.rate('demo-new:'+req.ip,5);await rate.rate('demo-new-global',40);
      await main.transaction(async()=>{const expired=await main.all('SELECT schema_name FROM public.alphaq_demo_workspaces WHERE expires_at<? LIMIT 10',Date.now());for(const item of expired)if(/^aq_demo_[a-f0-9]{24}$/.test(item.schema_name)){await main.exec(`DROP SCHEMA IF EXISTS "${item.schema_name}" CASCADE`);await main.run('DELETE FROM public.alphaq_demo_workspaces WHERE schema_name=?',item.schema_name);cache.delete(item.schema_name);}if((await main.get('SELECT COUNT(*) AS n FROM public.alphaq_demo_workspaces')).n>=40)throw new AppError(429,'The demo is busy. Please try again later.');});
      const fresh=randomBytes(24).toString('hex'),schema='aq_demo_'+randomBytes(12).toString('hex');
      record={schema_name:schema};
      const scoped=main.fork(schema);await scoped.migrate();await seedDemo(scoped);
      const encoded=await(demoPassword??=hashPassword('AlphaQ demo access 2026!'));
      await scoped.transaction(async()=>{for(const role of ['owner','manager','staff','customer'])await scoped.run('INSERT INTO users VALUES(?,?,?,?,?,?,0,?)','demo-'+role,role+'@demo.alphaq.example','Demo '+role,encoded,role,role==='customer'?'acme':null,new Date().toISOString());await scoped.run("UPDATE business_settings SET name='AlphaQ demo',customer_signup=0 WHERE id=1");await scoped.run("UPDATE billing_subscription SET plan_id='starter' WHERE id=1");});
      await main.run('INSERT INTO public.alphaq_demo_workspaces VALUES(?,?,?,?)',createHash('sha256').update(fresh).digest('hex'),schema,Date.now(),Date.now()+24*3600000);
      res.cookie('aq_demo_workspace',fresh,{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:24*3600000,path:'/'});
    }
    const schema=record.schema_name as string;if(!/^aq_demo_[a-f0-9]{24}$/.test(schema))throw new AppError(500,'Demo workspace unavailable.');
    let entry=cache.get(schema);if(!entry){const workflow=new Workflow(main.fork(schema),{...scriptedDemoProvider,insights:ai.insights?.bind(ai)},true),app=express();registerRoutes(app,workflow,true);entry={app,workflow};if(cache.size>=40)cache.delete(cache.keys().next().value!);cache.set(schema,entry);}
    if(req.path==='/reset'&&req.method==='POST'){const scoped=entry.workflow.store,auth=new AuthService(scoped,new BillingService(scoped),'aq_demo_session');await auth.logout(req,res);await main.run('UPDATE public.alphaq_demo_workspaces SET expires_at=? WHERE schema_name=?',Date.now()+5*60000,schema);res.clearCookie('aq_demo_workspace',{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',path:'/'});res.json({ok:true});return;}
    if(req.path==='/insights'){await rate.rate('demo-ai-global',6);await rate.rate('demo-ai:'+req.ip,3);}
    if(['/auth/setup','/auth/signup','/auth/accept-invite','/auth/password'].includes(req.path)||req.path.startsWith('/team/invitations'))throw new AppError(403,'Demo accounts are fixed. Use the role switcher to explore.');
    const workflow=entry.workflow;res.on('finish',()=>onBackground(workflow.drain()));req.url='/api'+req.url;entry.app(req,res,next);
  }catch(error){next(error);}};
}
