import {it,expect} from 'vitest';
import request from 'supertest';
import {Store,seedCatalogue} from '../server/db';
import {Workflow} from '../server/workflow';
import {createApp} from '../server/app';
import {scriptedDemoProvider} from '../server/sandbox';
it('isolates persistent demo accounts, enforces all four roles and dispatches exactly once',async()=>{
 const store=new Store(':memory:');await seedCatalogue(store);const background:Promise<unknown>[]=[];const app=createApp(new Workflow(store,scriptedDemoProvider),p=>{background.push(p);}),agent=request.agent(app),base='/api/demo-session';
 try{
  await request(app).get('/api/bootstrap').expect(401);await request(app).post('/api/auth/demo').send({role:'owner'}).expect(404);
  let login=await agent.post(base+'/auth/demo').send({role:'customer'}).expect(200);let csrf=login.body.csrfToken;
  expect(login.body.user.role).toBe('customer');await agent.get(base+'/bootstrap').expect(403);await agent.get('/api/bootstrap').expect(401);
  const created=await agent.post(base+'/orders').set('X-CSRF-Token',csrf).send({customerId:'acme',reference:'DEMO-FLOW',message:'2 A5 notebooks and 1 black desk organiser'}).expect(202);await Promise.all(background);
  const token=created.body.trackingToken,id=created.body.order.id;let order=(await agent.get(base+'/track/'+token).expect(200)).body;expect(order.status).toBe('awaiting_confirmation');expect(order.total).toBe(74000);
  await agent.post(base+'/track/'+token+'/confirm').send({version:1}).expect(403);await agent.post(base+'/track/'+token+'/confirm').set('X-CSRF-Token',csrf).send({version:1}).expect(200);await Promise.all(background);
  await agent.post(base+'/orders').set('X-CSRF-Token',csrf).send({customerId:'cedar',reference:'WRONG-COMPANY',message:'2 A5 notebooks'}).expect(403);
  login=await agent.post(base+'/auth/demo').send({role:'staff'}).expect(200);csrf=login.body.csrfToken;expect((await agent.get(base+'/bootstrap').expect(200)).body.orders.length).toBeGreaterThan(6);order=(await agent.get(base+'/orders/'+id).expect(200)).body;
  await agent.post(base+'/orders/'+id+'/approval').set('X-CSRF-Token',csrf).send({approvalId:order.approval.id,decision:'approve'}).expect(403);await agent.get(base+'/billing').expect(403);
  login=await agent.post(base+'/auth/demo').send({role:'manager'}).expect(200);csrf=login.body.csrfToken;await agent.get(base+'/billing').expect(403);
  const buying=(await agent.get(base+'/restock').expect(200)).body;expect(buying.find((i:any)=>i.productId==='stapler').shortage).toBe(8);await agent.get(base+'/activity').expect(200);
  await agent.post(base+'/orders/'+id+'/approval').set('X-CSRF-Token',csrf).send({approvalId:order.approval.id,decision:'approve'}).expect(200);await Promise.all(background);await agent.post(base+'/orders/'+id+'/approval').set('X-CSRF-Token',csrf).send({approvalId:order.approval.id,decision:'approve'}).expect(200);
  order=(await agent.get(base+'/orders/'+id).expect(200)).body;expect(order.status).toBe('dispatched');expect(order.sentMessages).toHaveLength(1);
  login=await agent.post(base+'/auth/demo').send({role:'owner'}).expect(200);await agent.get(base+'/billing').expect(200);expect((await agent.get(base+'/team').expect(200)).body.users).toHaveLength(4);
  expect((await store.get('SELECT COUNT(*) AS n FROM users')).n).toBe(0);expect((await store.get('SELECT COUNT(*) AS n FROM orders')).n).toBe(0);
  const cookies=login.headers['set-cookie'];expect(String(cookies)).toContain('HttpOnly');expect(String(cookies)).toContain('aq_demo_session');
  await agent.post(base+'/reset').send({}).expect(403);await agent.post(base+'/reset').set('X-CSRF-Token',login.body.csrfToken).send({}).expect(200);await agent.get(base+'/bootstrap').expect(401);
 }finally{await Promise.all(background);await store.close();}
},30000);
