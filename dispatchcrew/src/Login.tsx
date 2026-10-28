import { useState } from 'react';
import { ArrowLeft,ArrowRight,ArrowUpRight,Check,LockKeyhole } from 'lucide-react';
import { api,useQuery,enterDemo,leaveDemo,inDemoSession,loginDemo } from './api';
import { AlphaLogo } from './Landing';
import { useSession } from './session';
import type { AuthState } from '../shared/types';
const roles=['customer','manager','staff','owner'] as const;
export function Login(){
  const params=new URLSearchParams(location.search),initial=params.get('role')||(/dashboard|operations/.test(params.get('next')||'')?'manager':'customer'),invite=params.get('invite');
  const [demoMode,setDemoMode]=useState(false);
  const [role,setRole]=useState<string>(roles.includes(initial as any)?initial:'customer'),[signup,setSignup]=useState(params.get('signup')==='1');
  const {state,setAuth,loading}=useSession();
  const [email,setEmail]=useState(''),[password,setPassword]=useState(''),[name,setName]=useState(''),[company,setCompany]=useState(''),[address,setAddress]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const setup=!demoMode&&state?.setupAllowed!==false&&state?.setupRequired&&role==='owner'&&!invite;
  const invitation=useQuery<{email:string;role:string}>(invite?`/auth/invitation/${invite}`:'/auth/me',60000);
  function destination(value:AuthState){const raw=params.get('next');if(raw){try{const next=new URL(raw,location.origin),path=next.pathname,allowed=path==='/account'||path==='/order'||path.startsWith('/track/')||(value.user?.role!=='customer'&&(path==='/dashboard'||path==='/operations'));if(next.origin===location.origin&&allowed)return next.pathname+next.search+next.hash;}catch{}}return value.user?.role==='customer'?'/account':'/dashboard';}
  async function submit(event:React.FormEvent){event.preventDefault();setBusy(true);setError('');try{
    if(demoMode){const value=await loginDemo(email,password);setAuth(value);location.assign(destination(value));return;}
    const path=invite?'/auth/accept-invite':setup?'/auth/setup':signup?'/auth/signup':'/auth/login';
    const input=invite?{token:invite,name,password}:setup?{email,name,password,businessName:company}:signup?{email,name,password,company,address}:{email,password};
    const value=await api<AuthState>(path,input);setAuth(value);location.assign(destination(value));
  }catch(e){setError(e instanceof Error?e.message:'Sign-in could not complete.');}finally{setBusy(false);}}
  async function demoLogin(){setBusy(true);setError('');try{const value=await enterDemo(role);setAuth(value);location.assign(value.user.role==='customer'?'/account':'/dashboard');}catch(e){setError(e instanceof Error?e.message:'Demo unavailable.');}finally{setBusy(false);}}
  return <div className="aq-auth-page"><div className="aq-auth-background"/><header className="aq-auth-header"><AlphaLogo/><a href="/demo?tour=1">Explore the demo<ArrowUpRight size={15}/></a></header><main className="aq-auth-layout"><div className="aq-auth-message"><a className="aq-text-link" href="/"><ArrowLeft size={14}/>Back to AlphaQ</a><h1>A place<br/>to <em>build.</em></h1><p>Your orders. Your people.<br/>A little more clarity.</p></div><section className="aq-auth-panel"><span className="aq-lock"><LockKeyhole size={19}/></span><h2>{demoMode?'Explore AlphaQ.':invite?'You’re invited.':setup?'Make it yours.':signup?'Welcome aboard.':'Good to see you.'}</h2><p>{demoMode?'A sample account, with real permissions.':invite?'Create your account to join the workspace.':setup?'Set up the wholesaler’s owner account.':signup?'Create a free customer account.':'Sign in to your workspace.'}</p>
    {!invite&&!signup&&<div className="aq-role-tabs" role="group" aria-label="Account type">{roles.map(r=><button key={r} type="button" className={role===r?'active':''} onClick={()=>{setRole(r);setError('');if(demoMode)setEmail(r+'@demo.alphaq.example');}}>{r[0].toUpperCase()+r.slice(1)}</button>)}</div>}
    {loading?<p className="aq-muted">Checking your workspace…</p>:<form onSubmit={submit}>{error&&<div className="aq-error" role="alert">{error}</div>}{invite&&<div className="aq-invite-note">{invitation.data&&'email' in invitation.data?`${invitation.data.email} · ${invitation.data.role}`:invitation.error||'Opening your invitation…'}</div>}
    {(setup||signup||invite)&&<label>Your name<input required value={name} onChange={e=>setName(e.target.value)} autoComplete="name" minLength={2} maxLength={80}/></label>}
    {!invite&&<label>Email<input type="email" required value={email} onChange={e=>setEmail(e.target.value)} autoComplete="username" maxLength={254}/></label>}
    {(setup||signup)&&<label>{setup?'Business name':'Company name'}<input required value={company} onChange={e=>setCompany(e.target.value)} minLength={2} maxLength={80} autoComplete="organization"/></label>}
    {signup&&<label>Delivery address<textarea required value={address} onChange={e=>setAddress(e.target.value)} minLength={8} maxLength={300} autoComplete="street-address" rows={2}/></label>}
    <label>Password<input type="password" required value={password} onChange={e=>setPassword(e.target.value)} minLength={setup||signup||invite?15:1} maxLength={128} autoComplete={setup||signup||invite?'new-password':'current-password'}/></label>
    {(setup||signup||invite)&&<small className="aq-password-note">Use a passphrase of at least 15 characters.</small>}
    <button className="aq-pill aq-pill-light aq-wide" disabled={busy||Boolean(invite&&invitation.error)}>{busy?'Opening…':invite?'Join workspace':setup?'Create owner account':signup?'Create customer account':'Sign in'}<ArrowRight size={17}/></button></form>}
    {!invite&&!setup&&!demoMode&&<div className="aq-auth-switch">{signup?'Already have an account?':'New customer?'} <button onClick={()=>{setSignup(!signup);setRole('customer');setError('');}}>{signup?'Sign in':'Create an account'}</button></div>}
    {!demoMode&&state?.setupAllowed!==false&&state?.setupRequired&&role!=='owner'&&!invite&&<div className="aq-invite-note">This workspace needs an owner first. <button onClick={()=>{setRole('owner');setSignup(false);}}>Set up the owner account</button></div>}
    {!invite&&<div className="aq-demo-login"><button className="aq-subtle-link" onClick={()=>{setDemoMode(!demoMode);setSignup(false);setError('');setEmail(demoMode?'':role+'@demo.alphaq.example');setPassword(demoMode?'':'AlphaQ demo access 2026!');}}>{demoMode?'Use my real account':'Fill example credentials'}</button>{demoMode&&<div className="aq-example-credentials"><code>{role}@demo.alphaq.example</code><code>AlphaQ demo access 2026!</code><small>Public demo credentials · sample workspace only</small></div>}<span>JUST EXPLORING?</span><button type="button" className="aq-pill aq-pill-outline aq-wide" disabled={busy} onClick={demoLogin}>{busy?'Opening demo…':'Try as '+role}<ArrowRight size={16}/></button><small>Sample accounts. No password or AI credits needed.</small>{inDemoSession()&&<button className="aq-subtle-link" onClick={leaveDemo}>Leave demo for real sign-in</button>}</div>}
    <div className="aq-auth-assurance"><Check size={13}/>{signup?'Customers order for free.':'Your permissions follow your account, not the selected tab.'}</div></section></main></div>;
}
