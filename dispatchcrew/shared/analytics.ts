import type { OrderSummary,Product } from './types';
export function workspaceFacts(orders:OrderSummary[],products:Product[]) {
  return {orders:orders.length,awaitingApproval:orders.filter(o=>o.status==='awaiting_approval').length,needsAttention:orders.filter(o=>['on_hold','needs_clarification','failed','interrupted'].includes(o.status)).length,dispatched:orders.filter(o=>o.status==='dispatched').length,orderValuePaise:orders.reduce((sum,o)=>sum+o.total,0),lowStock:products.filter(p=>p.available<10).map(p=>({name:p.name,available:p.available}))};
}
export function dailyOrders(orders:OrderSummary[],days=7) {
  const end=new Date();end.setHours(12,0,0,0);
  return Array.from({length:days},(_,i)=>{const day=new Date(end);day.setDate(day.getDate()-days+1+i);const key=day.toLocaleDateString('en-CA');return {date:day.toISOString(),label:day.toLocaleDateString('en-IN',{weekday:'short'}),count:orders.filter(o=>new Date(o.createdAt).toLocaleDateString('en-CA')===key).length};});
}
