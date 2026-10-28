export type OrderStatus = 'interpreting' | 'needs_clarification' | 'awaiting_confirmation' | 'preparing' | 'on_hold' | 'awaiting_approval' | 'dispatching' | 'dispatched' | 'failed' | 'interrupted' | 'rejected';
export interface Customer { id: string; name: string; address: string }
export interface Product { id: string; name: string; sku: string; price: number; aliases: string[]; onHand: number; reserved: number; available: number }
export interface IntakeLine { productText: string; quantity: number | null; evidence: string }
export interface Intake { lines: IntakeLine[]; deliveryAddress: string | null; questions: string[]; plan: string[] }
export interface Draft { summary: string; message: string }
export interface Line { index: number; productId: string | null; name: string; quantity: number | null; unitPrice: number; total: number; available?: number }
export interface Question { id: string; label: string; kind: 'product' | 'quantity' | 'details'; lineIndex: number | null; options: { value: string; label: string }[] }
export interface StockImpact { productId: string; name: string; quantity: number; onHand: number; reserved: number; available: number; after: number; unitPrice: number }
export interface Approval { id: string; decision: string; version: number; impact: StockImpact[]; message: string; summary: string; total: number; address: string }
export interface ExecutionEvent { id: number; role: string; title: string; detail: string; at: string; visibility: string }
export interface Task { id: string; role: string; title: string; state: string; attempts: number; output: unknown }
export interface ShortageOption {
  id: string; kind: 'reduce' | 'substitute' | 'remove'; productId: string | null; name: string;
  quantity: number; unitPrice: number; total: number; priceDifference: number; explanation: string;
}
export interface ShortageChoices {
  quoteId: string; version: number; issues: {
    productId: string; name: string; requested: number; currentTotal: number; options: ShortageOption[];
  }[];
}
export interface ShortageSelection { originalProductId: string; optionId: string }
export interface OrderRevision {
  fromVersion: number; toVersion: number; kind: string; before: { lines: Line[]; total: number; message: string };
  after: { lines: Line[]; total: number; message: string }; at: string;
}
export interface CustomerOrder {
  id: string; reference: string; customer: Customer; status: OrderStatus; version: number; message: string; address: string;
  lines: Line[]; questions: Question[]; total: number; createdAt: string; updatedAt: string;
  timeline: ExecutionEvent[]; dispatch: { reference: string; at: string; simulated: true } | null;
  nextAction: string; error: string | null; waitingForStock: boolean;
  shortageChoices: ShortageChoices | null;
  canRespond?: boolean;
}
export interface ManagementOrder extends CustomerOrder {
  runId: string; trackingToken: string; approval: Approval | null; events: ExecutionEvent[]; tasks: Task[];
  restock: { name: string; requested: number; available: number; shortage: number }[];
  sentMessages: { body: string; at: string; simulated: true }[]; failureStage: string | null; faultsRemaining: number; aiSource: string;
  revisions: OrderRevision[];
}
export interface OrderSummary { id: string; reference: string; customer: string; status: OrderStatus; total: number; lineCount: number; createdAt: string; updatedAt: string; products: string; aiSource: string }
export interface Bootstrap { customers: Customer[]; products: Product[]; orders: OrderSummary[]; aiConfigured: boolean; model: string; demoControls: boolean }
export type UserRole = 'owner' | 'manager' | 'staff' | 'customer';
export interface AuthUser { id: string; email: string; name: string; role: UserRole; customerId: string | null; disabled: boolean }
export interface AuthState { user: AuthUser | null; csrfToken: string | null; setupRequired: boolean; businessName: string; customerSignup: boolean; setupAllowed?:boolean; demo?:boolean }
export interface Plan { id: 'free' | 'starter' | 'pro'; name: string; monthlyPrice: number; orderLimit: number; seatLimit: number }
export interface BillingState {
  simulated: true; plan: Plan; plans: Plan[]; version: number; usage: { orders: number; seats: number; periodStart: string; periodEnd: string };
  history: { id: string; planId: string; status: string; amount: number; createdAt: string; completedAt: string | null }[];
}
export const statusLabels: Record<OrderStatus, string> = {
  interpreting: 'Interpreting', needs_clarification: 'Needs details', awaiting_confirmation: 'Awaiting confirmation', preparing: 'Preparing', on_hold: 'Stock hold', awaiting_approval: 'Needs approval', dispatching: 'Dispatching', dispatched: 'Dispatched', failed: 'Action failed', interrupted: 'Interrupted', rejected: 'Rejected',
};
export const money = (paise: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(paise / 100);
