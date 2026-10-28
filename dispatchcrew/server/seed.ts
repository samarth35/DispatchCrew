import { pathToFileURL } from 'node:url';
import { Store, seedCatalogue } from './db.js';
import { Workflow } from './workflow.js';
import type { AIProvider } from './ai.js';
import type { Intake } from '../shared/types.js';

const scenarios = [
  {reference:'DC-1001',customerId:'acme',message:'20 A5 notebooks and 10 black desk organisers',lines:[['A5 notebooks',20],['black desk organisers',10]],confirm:true},
  {reference:'DC-1002',customerId:'form',message:'20 A5 notebooks',lines:[['A5 notebooks',20]],confirm:false},
  {reference:'DC-1003',customerId:'cedar',message:'10 A5 notebooks and 10 document folders',lines:[['A5 notebooks',10],['document folders',10]],confirm:true,dispatch:true},
  {reference:'DC-1004',customerId:'northstar',message:'12 desktop staplers and 5 A4 paper reams',lines:[['desktop staplers',12],['A4 paper reams',5]],confirm:true},
  {reference:'DC-1005',customerId:'paperplane',message:'25 notebooks',lines:[['notebooks',25]],confirm:false},
  {reference:'DC-1006',customerId:'acme',message:'20 A5 notebooks and 10 black desk organisers',lines:[['A5 notebooks',20],['black desk organisers',10]],confirm:true},
] as const;
export async function seedExamples(store:Store) {
  (await seedCatalogue(store));if((await store.get('SELECT id FROM orders LIMIT 1'))) return;
  const fixture:AIProvider={configured:true,source:'seeded',async interpret(message){
    const s=scenarios.find(s=>s.message===message)!;
    return {lines:s.lines.map(([productText,quantity])=>({productText,quantity,evidence:message})),deliveryAddress:null,questions:[],plan:['resolve_products','customer_confirmation','check_inventory','prepare_fulfilment','manager_approval','dispatch']} as Intake;
  },async draft(facts:any){return {summary:`Pick ${facts.lines.map((l:any)=>`${l.quantity} × ${l.name}`).join(', ')}. Verify quantities before handoff.`,message:`Your order for ${facts.lines.map((l:any)=>`${l.quantity} × ${l.name}`).join(', ')} has been recorded as a simulated warehouse dispatch. No real shipment has been made.`};}};
  const workflow=new Workflow(store,fixture);
  for(const s of scenarios) {
    const {order}=(await workflow.create(s));await workflow.idle(order.id);
    if(s.confirm) {(await workflow.confirm(order.id,1));await workflow.idle(order.id);}
    if('dispatch' in s&&s.dispatch) {const a=(await workflow.management(order.id)).approval!;(await workflow.approve(order.id,{approvalId:a.id,decision:'approve'}));await workflow.idle(order.id);}
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  const store=new Store();
  if(process.argv.includes('--reset')) {
    throw new Error('Reset is disabled for persistent Postgres. Use a separate demo workspace.');
  }
  await seedExamples(store);console.log('DispatchCrew catalogue and six labelled example orders are ready.');(await store.close());
}
