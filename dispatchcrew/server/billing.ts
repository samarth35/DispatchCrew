import { randomUUID } from 'node:crypto';
import { Store } from './db';
import { AppError, type Workflow } from './workflow';
import type { BillingState, Plan } from '../shared/types';

export const PLANS: Plan[] = [
  {id:'free',name:'Free',monthlyPrice:0,orderLimit:25,seatLimit:2},
  {id:'starter',name:'Starter',monthlyPrice:99900,orderLimit:250,seatLimit:5},
  {id:'pro',name:'Pro',monthlyPrice:249900,orderLimit:1000,seatLimit:15},
];
export class BillingService {
  constructor(public store:Store, private clock:()=>Date=()=>new Date()) {}
  plan():Plan { const id=this.store.get('SELECT plan_id FROM billing_subscription WHERE id=1')!.plan_id;return PLANS.find(p=>p.id===id)||PLANS[0]; }
  period() { const date=this.clock();return {start:new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),1)).toISOString(),end:new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1)).toISOString()}; }
  seats() { return Number(this.store.get("SELECT COUNT(*) AS n FROM users WHERE role<>'customer' AND disabled=0")!.n); }
  orderCount() { const period=this.period();return Number(this.store.get('SELECT COUNT(*) AS n FROM order_usage WHERE at>=? AND at<?',period.start,period.end)!.n); }
  ensureSeat() { if(this.seats()>=this.plan().seatLimit) throw new AppError(409,'The staff-seat limit is reached. Disable an unused account or change the simulated plan.'); }
  createOrder(workflow:Workflow,input:{customerId:string;reference:string;message:string}) {
    return this.store.transaction(()=>{
      const exists=this.store.get('SELECT id FROM orders WHERE customer_id=? AND reference=?',input.customerId,input.reference);
      if(!exists&&this.orderCount()>=this.plan().orderLimit) throw new AppError(403,'The business has reached its monthly order limit. Existing orders can still be completed; ask the owner to review the plan.');
      const result=workflow.create(input);
      if(!result.replayed)this.store.run('INSERT INTO order_usage VALUES(?,?)',result.order.id,this.clock().toISOString());
      return result;
    });
  }
  state():BillingState {
    const period=this.period();return {simulated:true,plan:this.plan(),plans:PLANS,version:this.store.get('SELECT version FROM billing_subscription WHERE id=1')!.version,usage:{orders:this.orderCount(),seats:this.seats(),periodStart:period.start,periodEnd:period.end},history:this.store.all('SELECT id,plan_id AS planId,status,amount,created_at AS createdAt,completed_at AS completedAt FROM billing_checkouts ORDER BY rowid DESC LIMIT 30')};
  }
  checkout(planId:string,requestId:string) {
    const plan=PLANS.find(p=>p.id===planId);if(!plan||plan.id==='free')throw new AppError(400,'Choose a paid simulation tier. Use cancel to return to Free.');
    const previous=this.store.get('SELECT * FROM billing_checkouts WHERE request_id=?',requestId);
    if(previous){if(previous.plan_id!==planId)throw new AppError(409,'This checkout request already belongs to another plan.');return this.checkoutView(previous);}
    const id=randomUUID(),version=this.state().version;
    this.store.run('INSERT INTO billing_checkouts(id,request_id,plan_id,amount,base_version,created_at) VALUES(?,?,?,?,?,?)',id,requestId,plan.id,plan.monthlyPrice,version,this.clock().toISOString());
    return this.checkoutView(this.store.get('SELECT * FROM billing_checkouts WHERE id=?',id)!);
  }
  private checkoutView(row:any){return {id:row.id,planId:row.plan_id,amount:row.amount,status:row.status,simulated:true};}
  complete(id:string,result:'success'|'failure',actorId:string) {
    return this.store.transaction(()=>{
      const checkout=this.store.get('SELECT * FROM billing_checkouts WHERE id=?',id);if(!checkout)throw new AppError(404,'Checkout not found.');
      const target=result==='success'?'succeeded':'failed';
      if(checkout.status!=='pending'){if(checkout.status!==target)throw new AppError(409,'This simulation is already completed with another result.');return this.state();}
      if(checkout.base_version!==this.state().version)throw new AppError(409,'The plan changed after this checkout was created. Start a new simulation.');
      const plan=PLANS.find(p=>p.id===checkout.plan_id)!;
      if(result==='success'&&this.seats()>plan.seatLimit)throw new AppError(409,'Disable extra staff accounts before switching to this plan.');
      if(result==='success')this.store.run('UPDATE billing_subscription SET plan_id=?,version=version+1 WHERE id=1',plan.id);
      this.store.run('UPDATE billing_checkouts SET status=?,completed_at=? WHERE id=?',target,this.clock().toISOString(),id);
      this.store.run('INSERT INTO security_events(actor_id,action,detail,at) VALUES(?,?,?,?)',actorId,'billing_simulation',JSON.stringify({checkoutId:id,result,plan:plan.id,simulated:true}),this.clock().toISOString());
      return this.state();
    });
  }
  cancel(version:number,actorId:string) {
    return this.store.transaction(()=>{
      if(version!==this.state().version)throw new AppError(409,'The subscription changed. Refresh before returning to Free.');
      if(this.seats()>PLANS[0].seatLimit)throw new AppError(409,'Disable extra staff accounts before returning to Free.');
      if(this.plan().id!=='free')this.store.run("UPDATE billing_subscription SET plan_id='free',version=version+1 WHERE id=1");
      this.store.run('INSERT INTO security_events(actor_id,action,detail,at) VALUES(?,?,?,?)',actorId,'billing_cancelled','Simulated plan returned to Free; usage retained.',this.clock().toISOString());
      return this.state();
    });
  }
}
