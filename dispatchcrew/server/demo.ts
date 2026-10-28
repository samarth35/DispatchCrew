import { Store,seedCatalogue } from './db.js';
import type { Bootstrap,OrderStatus } from '../shared/types.js';
let cached:Promise<Bootstrap>|null=null;
export function demoWorkspace():Promise<Bootstrap>{return cached??=makeDemoWorkspace();}
async function makeDemoWorkspace():Promise<Bootstrap> {
  const store=new Store(':memory:');(await seedCatalogue(store));
  const products=(await store.products()),customers=(await store.customers());(await store.close());
  const statuses:OrderStatus[]=['dispatched','awaiting_approval','needs_clarification','on_hold','dispatched','awaiting_confirmation','dispatched'];
  const days=[0,0,1,2,4,4,6],values=[74000,740000,0,439000,200000,240000,150000];
  const customerNames=['Acme Studio','Acme Studio','Paperplane Co','Northstar Office','Cedar Workspace','Form & Field','Paperplane Co'];
  return {customers,products,aiConfigured:Boolean(process.env.OPENROUTER_API_KEY),model:process.env.OPENROUTER_MODEL||'openrouter/free',demoControls:false,orders:statuses.map((status,i)=>{
    const date=new Date();date.setDate(date.getDate()-days[i]);date.setHours(10+i,15,0,0);
    return {id:`sample-${i+1}`,reference:`AQ-${1007-i}`,customer:customerNames[i],status,total:values[i],lineCount:2,createdAt:date.toISOString(),updatedAt:date.toISOString(),products:i===3?'Desktop stapler, A4 paper ream':'A5 notebook, Black desk organiser',aiSource:'sample'};
  })};
}
