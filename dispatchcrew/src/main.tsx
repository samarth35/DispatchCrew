import React from 'react';
import { createRoot } from 'react-dom/client';
import { Management } from './Management';
import { CustomerView } from './Customer';
import './styles.css';
class ErrorBoundary extends React.Component<{children:React.ReactNode},{failed:boolean}>{state={failed:false};static getDerivedStateFromError(){return {failed:true};}render(){return this.state.failed?<main className="fatal"><h1>Let’s reopen the desk.</h1><p>The interface couldn’t finish loading. Your saved orders are safe.</p><button className="button primary" onClick={()=>location.reload()}>Reload workspace</button></main>:this.props.children;}}
const customer=location.pathname==='/order'||location.pathname.startsWith('/track/');
createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary>{customer?<CustomerView/>:<Management/>}</ErrorBoundary></React.StrictMode>);
