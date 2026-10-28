import { Store } from './db';
import { seedExamples } from './seed';
import { OpenRouterProvider } from './ai';
import { Workflow } from './workflow';
import { createApp } from './app';
const store=new Store();await seedExamples(store);
const workflow=new Workflow(store,new OpenRouterProvider(),process.env.DEMO_CONTROLS!=='false');
const server=createApp(workflow).listen(Number(process.env.PORT||3001),'127.0.0.1',()=>console.log(`DispatchCrew API · http://127.0.0.1:${process.env.PORT||3001} · AI ${workflow.ai.configured?'configured':'not configured'}`));
for(const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>{server.close();void workflow.drain().then(()=>{store.close();process.exit(0);});});
