import { createContext,useContext,useEffect,useState } from 'react';
import { api,setCsrfToken } from './api';
import type { AuthState } from '../shared/types';
const SessionContext=createContext<{state:AuthState|null;loading:boolean;error:string;setAuth:(value:AuthState)=>void;reload:()=>Promise<void>}>({state:null,loading:true,error:'',setAuth:()=>{},reload:async()=>{}});
export function SessionProvider({children}:{children:React.ReactNode}) {
  const [state,setState]=useState<AuthState|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const setAuth=(value:AuthState)=>{setState(value);setCsrfToken(value.csrfToken);setError('');setLoading(false);};
  async function reload(){setLoading(true);setError('');try{setAuth(await api<AuthState>('/auth/me'));}catch(e){setError(e instanceof Error?e.message:'Could not check your session.');}finally{setLoading(false);}}
  useEffect(()=>{void reload();const expired=()=>{setCsrfToken(null);setState(s=>s?{...s,user:null,csrfToken:null}:null);};window.addEventListener('alphaq:expired',expired);return()=>window.removeEventListener('alphaq:expired',expired);},[]);
  return <SessionContext.Provider value={{state,loading,error,setAuth,reload}}>{children}</SessionContext.Provider>;
}
export const useSession=()=>useContext(SessionContext);
export function Protected({children,employee=false}:{children:React.ReactNode;employee?:boolean}) {
  const {state,loading,error,reload}=useSession();
  useEffect(()=>{if(error)return;if(!loading&&!state?.user)location.replace(`/login?next=${encodeURIComponent(location.pathname+location.search)}`);else if(employee&&state?.user?.role==='customer')location.replace('/account');},[loading,state?.user?.id,employee,error]);
  if(error)return <main className="aq-service-state"><h1>Let’s reconnect.</h1><p>{error}</p><button className="aq-pill aq-pill-light" onClick={reload}>Retry connection</button><a href="/">Back to AlphaQ</a></main>;
  if(loading||!state?.user||(employee&&state.user.role==='customer'))return <div className="aq-page-loading">Opening your workspace…</div>;
  return <>{children}</>;
}
