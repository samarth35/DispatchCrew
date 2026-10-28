import { Store } from './db.js';
import { seedExamples } from './seed.js';
import { OpenRouterProvider } from './ai.js';
import { Workflow } from './workflow.js';
import { createApp } from './app.js';
const store=new Store();await store.migrate();
const workflow=new Workflow(store,new OpenRouterProvider(),process.env.DEMO_CONTROLS!=='false');
const server=createApp(workflow).listen(Number(process.env.PORT||3001),'127.0.0.1',()=>console.log(`DispatchCrew API · http://127.0.0.1:${process.env.PORT||3001} · AI ${workflow.ai.configured?'configured':'not configured'}`));
for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{server.close();void workflow.drain().then(async()=>{await store.close();process.exit(0);});});
