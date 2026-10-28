import { Store, seedCatalogue } from '../server/db';
import { Workflow } from '../server/workflow';
import { OpenRouterProvider } from '../server/ai';
const store=new Store(':memory:');(await seedCatalogue(store));
const workflow=new Workflow(store,new OpenRouterProvider());
try {
  const {order}=(await workflow.create({customerId:'acme',reference:'LIVE-CHECK',message:'We need 20 A5 notebooks and 10 black desk organisers for our office.'}));
  await workflow.idle(order.id);
  let current=(await workflow.management(order.id));
  if(current.status!=='awaiting_confirmation') throw new Error(current.error||`Unexpected intake state: ${current.status}`);
  (await workflow.confirm(order.id,current.version));await workflow.idle(order.id);
  current=(await workflow.management(order.id));
  if(current.status!=='awaiting_approval') throw new Error(current.error||`Unexpected preparation state: ${current.status}`);
  (await workflow.approve(order.id,{approvalId:current.approval!.id,decision:'approve'}));await workflow.idle(order.id);
  current=(await workflow.management(order.id));
  if(current.status!=='dispatched'||current.total!==740000) throw new Error('Live flow did not produce the expected dispatch and total.');
  console.log(JSON.stringify({result:'PASS',source:current.aiSource,totalPaise:current.total,status:current.status,dispatch:current.dispatch?.reference,events:current.events.length}));
} catch(error) {console.error(error instanceof Error?error.message:'Live check failed.');process.exitCode=1;} finally {(await store.close());}
