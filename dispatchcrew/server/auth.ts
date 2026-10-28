import { randomBytes,randomUUID,createHash,scrypt,timingSafeEqual } from 'node:crypto';
import type { Request,Response } from 'express';
import { z } from 'zod';
import { Store } from './db.js';
import { BillingService } from './billing.js';
import { AppError } from './workflow.js';
import type { AuthState,AuthUser,UserRole } from '../shared/types.js';

export const passwordSchema=z.string().min(15,'Use a passphrase of at least 15 characters.').max(128);
export const emailSchema=z.string().trim().toLowerCase().email().max(254);
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
const stamp=()=>new Date().toISOString();
const derive=(password:string,salt:Buffer)=>new Promise<Buffer>((resolve,reject)=>scrypt(password,salt,64,{N:32768,r:8,p:3,maxmem:64*1024*1024},(error,key)=>error?reject(error):resolve(key)));
export async function hashPassword(password:string){passwordSchema.parse(password);const salt=randomBytes(16);return `scrypt$32768$8$3$${salt.toString('hex')}$${(await derive(password,salt)).toString('hex')}`;}
export async function verifyPassword(password:string,encoded?:string){
  const parts=encoded?.split('$');
  const valid=parts?.length===6&&parts.slice(0,4).join('$')==='scrypt$32768$8$3'&&/^[a-f0-9]{32}$/.test(parts[4])&&/^[a-f0-9]{128}$/.test(parts[5]);
  const actual=await derive(password,valid?Buffer.from(parts![4],'hex'):Buffer.alloc(16));
  return Boolean(valid&&timingSafeEqual(actual,Buffer.from(parts![5],'hex')));
}
export interface SessionContext { user:AuthUser; csrfToken:string; tokenHash:string }
const userView=(row:any):AuthUser=>({id:row.id,email:row.email,name:row.name,role:row.role,customerId:row.customer_id,disabled:Boolean(row.disabled)});

export class AuthService {
  constructor(public store:Store,public billing:BillingService,private cookieName='dc_session'){}
  async setupRequired(){return !(await this.store.get("SELECT id FROM users WHERE role='owner' LIMIT 1"));}
  async settings(){return (await this.store.get('SELECT * FROM business_settings WHERE id=1'))!;}
  async audit(actorId:string|null,action:string,detail:unknown={}){(await this.store.run('INSERT INTO security_events(actor_id,action,detail,at) VALUES(?,?,?,?)',actorId,action,JSON.stringify(detail),stamp()));}
  async rate(bucket:string,limit=8){return this.store.transaction(async()=>{
    const key=digest(bucket),now=Date.now(),previous=(await this.store.get('SELECT * FROM auth_attempts WHERE bucket=?',key));
    if(!previous||now-previous.window_start>=15*60*1000){(await this.store.run('INSERT INTO auth_attempts VALUES(?,?,1) ON CONFLICT(bucket) DO UPDATE SET window_start=excluded.window_start,attempts=1',key,now));return;}
    if(previous.attempts>=limit)throw new AppError(429,'Too many account attempts. Please wait 15 minutes and try again.');
    (await this.store.run('UPDATE auth_attempts SET attempts=attempts+1 WHERE bucket=?',key));
  });}
  private sessionToken(req:Request){
    const match=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith(this.cookieName+'='));
    const token=match?.slice(this.cookieName.length+1);return token&&/^[A-Za-z0-9_-]{43}$/.test(token)?token:null;
  }
  async context(req:Request):Promise<SessionContext|null> {
    const token=this.sessionToken(req);if(!token)return null;
    const tokenHash=digest(token),row=(await this.store.get('SELECT s.*,u.id,u.email,u.name,u.role,u.customer_id,u.disabled FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?',tokenHash));
    if(!row)return null;
    if(row.disabled||Date.parse(row.expires_at)<=Date.now()||Date.now()-Date.parse(row.last_seen_at)>30*60*1000){(await this.store.run('DELETE FROM sessions WHERE token_hash=?',tokenHash));return null;}
    if(Date.now()-Date.parse(row.last_seen_at)>60000)(await this.store.run('UPDATE sessions SET last_seen_at=? WHERE token_hash=?',stamp(),tokenHash));
    return {user:userView(row),csrfToken:row.csrf_token,tokenHash};
  }
  async require(req:Request,roles?:UserRole[]):Promise<SessionContext> {
    const context=(await this.context(req));if(!context)throw new AppError(401,'Sign in to continue.');
    if(roles&&!roles.includes(context.user.role))throw new AppError(403,'Your account does not have permission for this action.');
    if(!['GET','HEAD','OPTIONS'].includes(req.method)){
      const supplied=req.get('X-CSRF-Token')||'';
      if(Buffer.byteLength(supplied)!==Buffer.byteLength(context.csrfToken)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(context.csrfToken)))throw new AppError(403,'The session check failed. Refresh the page and try again.');
    }
    return context;
  }
  async state(req:Request):Promise<AuthState> {
    const context=(await this.context(req)),settings=(await this.settings());return {user:context?.user||null,csrfToken:context?.csrfToken||null,setupRequired:(await this.setupRequired()),businessName:settings.name,customerSignup:Boolean(settings.customer_signup)};
  }
  private async issue(req:Request,res:Response,userId:string){
    const previous=this.sessionToken(req);if(previous)(await this.store.run('DELETE FROM sessions WHERE token_hash=?',digest(previous)));
    const token=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url'),date=new Date(),expires=new Date(date.getTime()+12*60*60*1000);
    (await this.store.run('INSERT INTO sessions VALUES(?,?,?,?,?,?)',digest(token),userId,csrf,date.toISOString(),date.toISOString(),expires.toISOString()));
    res.cookie(this.cookieName,token,{httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production',maxAge:12*60*60*1000,path:'/'});
    const user=(await this.store.get('SELECT * FROM users WHERE id=?',userId))!;(await this.audit(userId,'signed_in'));
    return {user:userView(user),csrfToken:csrf,setupRequired:false,businessName:(await this.settings()).name,customerSignup:Boolean((await this.settings()).customer_signup)} satisfies AuthState;
  }
  async setup(req:Request,res:Response,input:{email:string;name:string;password:string;businessName:string}){
    (await this.rate(`setup:${req.ip}`,5));if(!(await this.setupRequired()))throw new AppError(409,'The owner account is already configured. Please sign in.');
    const passwordHash=await hashPassword(input.password),id=randomUUID();
    (await this.store.transaction(async ()=>{
      if(!(await this.setupRequired()))throw new AppError(409,'The owner account was configured in another session.');
      (await this.store.run("INSERT INTO users(id,email,name,password_hash,role,created_at) VALUES(?,?,?,?,'owner',?)",id,input.email,input.name,passwordHash,stamp()));
      (await this.store.run('UPDATE business_settings SET name=? WHERE id=1',input.businessName));(await this.audit(id,'owner_setup'));
    }));return (await this.issue(req,res,id));
  }
  async login(req:Request,res:Response,email:string,password:string){
    (await this.rate(`login-ip:${req.ip}`,50));(await this.rate(`login-account:${email}`,8));
    const row=(await this.store.get('SELECT * FROM users WHERE email=?',email));
    const valid=await verifyPassword(password,row?.password_hash);
    if(!row||!valid||row.disabled){(await this.audit(null,'sign_in_failed',{account:digest(email)}));throw new AppError(401,'Email or password is incorrect, or this account is unavailable.');}
    (await this.store.run('DELETE FROM auth_attempts WHERE bucket=?',digest(`login-account:${email}`)));return (await this.issue(req,res,row.id));
  }
  async signup(req:Request,res:Response,input:{email:string;name:string;password:string;company:string;address:string}){
    (await this.rate(`signup:${req.ip}`,8));
    if((await this.setupRequired())||!(await this.settings()).customer_signup)throw new AppError(403,'Customer registration is not available yet. Ask the wholesaler for an invitation.');
    const passwordHash=await hashPassword(input.password),id=randomUUID(),customerId=randomUUID();
    (await this.store.transaction(async ()=>{
      if((await this.store.get('SELECT id FROM users WHERE email=?',input.email)))throw new AppError(409,'This email cannot be registered. Sign in or ask the owner for help.');
      (await this.store.run('INSERT INTO customers VALUES(?,?,?)',customerId,input.company,input.address));
      (await this.store.run("INSERT INTO users VALUES(?,?,?,?,'customer',?,0,?)",id,input.email,input.name,passwordHash,customerId,stamp()));(await this.audit(id,'customer_registered'));
    }));return (await this.issue(req,res,id));
  }
  async demoLogin(req:Request,res:Response,role:UserRole){const row=(await this.store.get('SELECT id FROM users WHERE id=? AND disabled=0','demo-'+role));if(!row)throw new AppError(403,'This demo account is disabled. Start a fresh demo workspace.');return (await this.issue(req,res,row.id));}
  async logout(req:Request,res:Response){const context=(await this.require(req));(await this.store.run('DELETE FROM sessions WHERE token_hash=?',context.tokenHash));(await this.audit(context.user.id,'signed_out'));res.clearCookie(this.cookieName,{path:'/',httpOnly:true,sameSite:'lax',secure:process.env.NODE_ENV==='production'});}
  async changePassword(req:Request,res:Response,current:string,next:string){
    const context=(await this.require(req));(await this.rate(`password:${context.user.id}`,5));const row=(await this.store.get('SELECT password_hash FROM users WHERE id=?',context.user.id))!;
    if(!await verifyPassword(current,row.password_hash))throw new AppError(400,'The current password was not accepted.');
    const encoded=await hashPassword(next);
    (await this.store.transaction(async ()=>{(await this.store.run('UPDATE users SET password_hash=? WHERE id=?',encoded,context.user.id));(await this.store.run('DELETE FROM sessions WHERE user_id=?',context.user.id));(await this.audit(context.user.id,'password_changed'));}));
    return (await this.issue(req,res,context.user.id));
  }
  async users(){return (await this.store.all('SELECT * FROM users ORDER BY created_at')).map(userView);}
  async createInvite(actorId:string,input:{email:string;role:'manager'|'staff'|'customer';customerId?:string}){
    return (await this.store.transaction(async ()=>{
      if((await this.store.get('SELECT id FROM users WHERE email=?',input.email)))throw new AppError(409,'This email already has an account. Manage the existing account instead.');
      if(input.role==='customer'){
        if(!input.customerId||!(await this.store.get('SELECT id FROM customers WHERE id=?',input.customerId)))throw new AppError(400,'Choose the existing customer record for this invitation.');
      } else (await this.billing.ensureSeat());
      const token=randomBytes(32).toString('base64url'),id=randomUUID(),expires=new Date(Date.now()+7*86400000).toISOString();
      (await this.store.run('UPDATE account_invites SET revoked_at=? WHERE email=? AND used_at IS NULL AND revoked_at IS NULL',stamp(),input.email));
      (await this.store.run('INSERT INTO account_invites VALUES(?,?,?,?,?,?,?,NULL,NULL,?)',id,digest(token),input.email,input.role,input.role==='customer'?input.customerId!:null,actorId,expires,stamp()));
      (await this.audit(actorId,'invitation_created',{inviteId:id,role:input.role,customerId:input.customerId||null}));
      return {id,token,email:input.email,role:input.role,expiresAt:expires};
    }));
  }
  async invitation(token:string){
    const invite=(await this.store.get('SELECT * FROM account_invites WHERE token_hash=?',digest(token)));
    if(!invite||invite.used_at||invite.revoked_at||Date.parse(invite.expires_at)<=Date.now())throw new AppError(404,'This invitation is unavailable or expired. Ask the owner for a new one.');
    return invite;
  }
  async acceptInvite(req:Request,res:Response,token:string,name:string,password:string){
    (await this.rate(`accept-invite:${req.ip}`,15));(await this.invitation(token));const encoded=await hashPassword(password),id=randomUUID();
    (await this.store.transaction(async ()=>{
      const invite=(await this.invitation(token));
      if((await this.store.get('SELECT id FROM users WHERE email=?',invite.email)))throw new AppError(409,'This email already has an account. Please sign in.');
      if(invite.role!=='customer')(await this.billing.ensureSeat());
      (await this.store.run('INSERT INTO users VALUES(?,?,?,?,?,?,0,?)',id,invite.email,name,encoded,invite.role,invite.customer_id,stamp()));
      (await this.store.run('UPDATE account_invites SET used_at=? WHERE id=?',stamp(),invite.id));(await this.audit(id,'invitation_accepted',{inviteId:invite.id}));
    }));return (await this.issue(req,res,id));
  }
  async manageUser(actorId:string,id:string,input:{role?:'manager'|'staff'|'customer';customerId?:string;disabled?:boolean}){
    return (await this.store.transaction(async ()=>{
      const row=(await this.store.get('SELECT * FROM users WHERE id=?',id));if(!row)throw new AppError(404,'Account not found.');
      if(row.role==='owner'||id===actorId)throw new AppError(403,'The owner account cannot be changed through team management.');
      const role=input.role||row.role,disabled=input.disabled??Boolean(row.disabled),customerId=role==='customer'?(input.customerId||row.customer_id):null;
      if(role==='customer'&&(!customerId||!(await this.store.get('SELECT id FROM customers WHERE id=?',customerId))))throw new AppError(400,'A customer account must be linked to a customer record.');
      const currentlyInternal=row.role!=='customer'&&!row.disabled,nextInternal=role!=='customer'&&!disabled;
      if(!currentlyInternal&&nextInternal)(await this.billing.ensureSeat());
      (await this.store.run('UPDATE users SET role=?,customer_id=?,disabled=? WHERE id=?',role,customerId,disabled?1:0,id));
      (await this.store.run('DELETE FROM sessions WHERE user_id=?',id));(await this.audit(actorId,'account_updated',{userId:id,role,disabled}));return userView((await this.store.get('SELECT * FROM users WHERE id=?',id))!);
    }));
  }
}
