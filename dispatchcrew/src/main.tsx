import React from 'react';
import { createRoot } from 'react-dom/client';
import { Management } from './Management';
import { CustomerView } from './Customer';
import './styles.css';
import './alphaq.css';
import './experience.css';
import {Landing} from './Landing';
import {Dashboard} from './Dashboard';
import {Login} from './Login';
import {Account,DemoBanner} from './Account';
import {Protected,SessionProvider} from './session';
class ErrorBoundary extends React.Component<{children:React.ReactNode},{failed:boolean}>{state={failed:false};static getDerivedStateFromError(){return {failed:true};}render(){return this.state.failed?<main className="fatal"><h1>Let’s reopen the desk.</h1><p>The interface couldn’t finish loading. Your saved orders are safe.</p><button className="button primary" onClick={()=>location.reload()}>Reload workspace</button></main>:this.props.children;}}
const path=location.pathname;
const page=path==='/'?<Landing/>:path==='/demo'?<Dashboard demo/>:path==='/login'?<Login/>:path==='/dashboard'?<Protected employee><Dashboard/></Protected>:path==='/account'?<Protected><Account/></Protected>:path==='/operations'?<Protected employee><Management/></Protected>:path==='/order'||path.startsWith('/track/')?<Protected><CustomerView/></Protected>:<main className="aq-page-loading">Page not found. <a href="/">Return home</a></main>;
createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><SessionProvider><DemoBanner/>{page}</SessionProvider></ErrorBoundary></React.StrictMode>);
