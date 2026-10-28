import { useCallback, useEffect, useRef, useState } from 'react';
export async function api<T>(path:string,body?:unknown,method=body?'POST':'GET'):Promise<T> {
  const response=await fetch(`/api${path}`,{method,headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined});
  const result=await response.json();if(!response.ok) throw new Error(result.error||'The request could not be completed.');return result;
}
export function useQuery<T>(path:string,interval=3000) {
  const [data,setData]=useState<T|null>(null),[error,setError]=useState('');
  const generation=useRef(0);
  const refresh=useCallback(async()=>{
    const current=generation.current;
    try {const value=await api<T>(path);if(current===generation.current){setData(value);setError('');}}
    catch(e){if(current===generation.current)setError(e instanceof Error?e.message:'Could not connect.');}
  },[path]);
  useEffect(()=>{let live=true;generation.current++;setData(null);let timer:ReturnType<typeof setTimeout>;async function poll(){await refresh();if(live)timer=setTimeout(poll,interval);}void poll();return()=>{live=false;generation.current++;clearTimeout(timer);};},[refresh,interval]);
  return {data,error,refresh};
}
