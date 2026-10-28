import { registerRoutes } from './routes.js';
import express, { type ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Workflow, AppError } from './workflow.js';
import {demoGateway} from './sandbox.js';

export function createApp(workflow: Workflow,onBackground:(promise:Promise<unknown>)=>void=()=>{}) {
  const app=express();
  app.disable('x-powered-by');
  if(process.env.VERCEL)app.set('trust proxy',1);
  app.use((req,res,next)=>{
    res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});
    const origin=req.headers.origin;
    const allowed=process.env.APP_ORIGIN,sameHost=process.env.NODE_ENV==='production'&&origin===`https://${req.headers.host}`;
    if(origin&&origin!==allowed&&!sameHost&&!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)){res.status(403).json({error:'This workspace does not accept requests from that origin.'});return;}
    next();
  });
  app.use(express.json({limit:'64kb'}));
  app.use('/api/demo-session',demoGateway(workflow.store,onBackground,workflow.ai));
  app.use((req,res,next)=>{res.on('finish',()=>onBackground(workflow.drain()));next();});
  registerRoutes(app,workflow);
  app.use('/api',(_req,res)=>res.status(404).json({error:'Endpoint not found.'}));
  const dist=resolve('dist');
  if(existsSync(dist)) { app.use(express.static(dist));app.get('/{*path}',(_req,res)=>res.sendFile(resolve(dist,'index.html'))); }
  const errors:ErrorRequestHandler=(error,req,res,_next)=>{
    if(error?.type==='entity.parse.failed'){res.status(400).json({error:'The request body is incomplete. Check the submitted fields and retry.'});return;}
    if(error?.type==='entity.too.large'){res.status(413).json({error:'This request is too large. Shorten the order message and retry.'});return;}
    if(error instanceof z.ZodError) {res.status(400).json({error:'Check the submitted fields.',details:error.issues.map(i=>({field:i.path.join('.'),message:i.message}))});return;}
    if(error instanceof AppError) {res.status(error.status).json({error:error.message});return;}
    console.error('[AlphaQ] Request failed',{route:req.route?.path||'unmatched',type:error?.name||'Error',code:error?.code||'unknown'});
    res.status(500).json({error:'This step could not finish. Your saved work is safe. Please retry.'});
  };
  app.use(errors);return app;
}
