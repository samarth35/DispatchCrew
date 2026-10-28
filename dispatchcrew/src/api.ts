import { useCallback, useEffect, useRef, useState } from 'react';
let csrfToken='';
let authTransition=false;
let pendingMutations=0;
const mutationWaiters:(()=>void)[]=[];
if(new URLSearchParams(location.search).get('demo')==='1')sessionStorage.setItem('alphaq-demo-session','1');
export const inDemoSession=()=>sessionStorage.getItem('alphaq-demo-session')==='1';
async function readResponse(response:Response){let value:any;try{value=await response.json();}catch{throw new Error(response.status===429?'The service is busy. Please try again shortly.':response.status>=500?'The service could not respond. Your saved work is safe; retry in a moment.':'The service returned an incomplete response. Please retry.');}if(!response.ok)throw new Error(value?.details?.[0]?.message||value?.error||'The request could not be completed.');return value;}
export async function enterDemo(role:string){authTransition=true;try{if(pendingMutations)await new Promise<void>(resolve=>mutationWaiters.push(resolve));const response=await fetch('/api/demo-session/auth/demo',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({role})});const value=await readResponse(response);sessionStorage.setItem('alphaq-demo-session','1');return value;}catch(error){authTransition=false;throw error;}}
export async function loginDemo(email:string,password:string){authTransition=true;try{const response=await fetch('/api/demo-session/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});const value=await readResponse(response);sessionStorage.setItem('alphaq-demo-session','1');return value;}catch(error){authTransition=false;throw error;}}
export function leaveDemo(){sessionStorage.removeItem('alphaq-demo-session');location.assign('/login');}
export function setCsrfToken(value:string|null){csrfToken=value||'';}
export async function api<T>(path:string,body?:unknown,method=body?'POST':'GET'):Promise<T> {
  const mutating=!['GET','HEAD'].includes(method);if(mutating){if(authTransition)throw new Error('Switching roles. Please wait for the workspace to open.');pendingMutations++;}
  try{
  const publicPath=path==='/plans'||path==='/health'||path.startsWith('/demo/');let response:Response;
  try{response=await fetch(`${inDemoSession()&&!publicPath?'/api/demo-session':'/api'}${path}`,{method,headers:body?{'Content-Type':'application/json','X-CSRF-Token':csrfToken}:undefined,body:body?JSON.stringify(body):undefined});}catch{throw new Error('Could not reach AlphaQ. Check your connection and retry.');}
  if(response.status===401&&!authTransition&&!publicPath&&!path.startsWith('/auth/'))window.dispatchEvent(new Event('alphaq:expired'));return await readResponse(response);
  }finally{if(mutating&&--pendingMutations===0)for(const done of mutationWaiters.splice(0))done();}
}
export function useQuery<T>(path:string,interval=3000) {
  const [data,setData]=useState<T|null>(null),[error,setError]=useState('');
  const generation=useRef(0);
  const failures=useRef(0);
  const refresh=useCallback(async()=>{
    const current=generation.current;
    try {const value=await api<T>(path);if(current===generation.current){failures.current=0;setData(value);setError('');}}
    catch(e){if(current===generation.current){failures.current++;setError(e instanceof Error?e.message:'Could not connect.');}}
  },[path]);
  useEffect(()=>{let live=true;generation.current++;failures.current=0;setData(null);let timer:ReturnType<typeof setTimeout>;async function poll(){await refresh();if(live)timer=setTimeout(poll,Math.min(30000,interval*Math.pow(2,Math.min(4,failures.current))));}void poll();return()=>{live=false;generation.current++;clearTimeout(timer);};},[refresh,interval]);
  return {data,error,refresh};
}
