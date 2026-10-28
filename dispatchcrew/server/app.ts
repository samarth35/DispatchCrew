import express, { type ErrorRequestHandler } from 'express';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Workflow, AppError } from './workflow';

export function createApp(workflow: Workflow) {
  const app=express();
  app.disable('x-powered-by');
  app.use((req,res,next)=>{
    res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});
    const origin=req.headers.origin;
    if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {res.status(403).json({error:'This local workspace does not accept cross-origin requests.'});return;}
    next();
  });
  app.use(express.json({limit:'64kb'}));
  app.get('/api/health',(_req,res)=>res.json({ok:true,aiConfigured:workflow.ai.configured}));
  app.get('/api/catalogue',(_req,res)=>res.json({customers:workflow.store.customers(),products:workflow.store.products().map(({id,name,sku,price})=>({id,name,sku,price}))}));
  app.get('/api/bootstrap',(_req,res)=>res.json({customers:workflow.store.customers(),products:workflow.store.products(),orders:workflow.summaries(),aiConfigured:workflow.ai.configured,model:workflow.ai.model||'openrouter/free',demoControls:workflow.demoControls}));
  app.get('/api/orders',(req,res)=>res.json(workflow.summaries()));
  app.post('/api/orders',(req,res)=>{
    const input=z.object({customerId:z.string().min(1),reference:z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9-]+$/),message:z.string().trim().min(3).max(6000)}).parse(req.body);
    const result=workflow.create(input);res.status(result.replayed?200:202).json(result);
  });
  app.get('/api/orders/:id',(req,res)=>res.json(workflow.management(z.string().parse(req.params.id))));
  app.post('/api/orders/:id/confirm',(req,res)=>{
    const id=z.string().parse(req.params.id),input=z.object({token:z.string(),version:z.number().int().positive()}).parse(req.body);
    if(workflow.byToken(input.token)!==id) throw new AppError(404,'Order not found.');
    workflow.confirm(id,input.version);res.json(workflow.customer(id));
  });
  app.post('/api/orders/:id/approval',(req,res)=>{
    const id=z.string().parse(req.params.id),input=z.object({approvalId:z.string().uuid(),decision:z.enum(['approve','reject']),reason:z.string().max(500).optional()}).parse(req.body);
    workflow.approve(id,input);res.json(workflow.management(id));
  });
  app.post('/api/orders/:id/fault',(req,res)=>{const id=z.string().parse(req.params.id);workflow.injectFault(id,z.object({count:z.number().int().min(1).max(3)}).parse(req.body).count);res.json({ok:true});});
  app.patch('/api/inventory/:id',(req,res)=>{workflow.adjustStock(z.string().parse(req.params.id),z.object({delta:z.number().int().min(-10000).max(10000).refine(n=>n!==0)}).parse(req.body).delta);res.json(workflow.store.products());});
  app.post('/api/runs/:id/resume',(req,res)=>{workflow.resume(z.string().parse(req.params.id));res.json({ok:true});});
  app.get('/api/track/:token',(req,res)=>res.json(workflow.customer(workflow.byToken(z.string().parse(req.params.token)))));
  app.get('/api/track/:token/shortage-choices',(req,res)=>res.json(workflow.shortageChoices(workflow.byToken(z.string().parse(req.params.token)))));
  app.post('/api/track/:token/shortage-choices',(req,res)=>{
    const id=workflow.byToken(z.string().parse(req.params.token));
    const input=z.object({version:z.number().int().positive(),quoteId:z.string().regex(/^[a-f0-9]{64}$/),selections:z.array(z.object({originalProductId:z.string().min(1),optionId:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).min(1).max(30)}).strict().parse(req.body);
    workflow.applyShortageChoices(id,input);res.json(workflow.customer(id));
  });
  app.post('/api/track/:token/confirm',(req,res)=>{const id=workflow.byToken(z.string().parse(req.params.token));workflow.confirm(id,z.object({version:z.number().int().positive()}).parse(req.body).version);res.json(workflow.customer(id));});
  app.post('/api/track/:token/reply',(req,res)=>{
    const id=workflow.byToken(z.string().parse(req.params.token));
    const input=z.object({action:z.enum(['clarify','revise','wait']),answers:z.record(z.string(),z.string().trim().min(1).max(1000)).optional(),message:z.string().trim().min(3).max(6000).optional()}).parse(req.body);
    workflow.reply(id,input);res.json(workflow.customer(id));
  });
  app.use('/api',(_req,res)=>res.status(404).json({error:'Endpoint not found.'}));
  const dist=resolve('dist');
  if(existsSync(dist)) { app.use(express.static(dist));app.get('/{*path}',(_req,res)=>res.sendFile(resolve(dist,'index.html'))); }
  const errors:ErrorRequestHandler=(error,_req,res,_next)=>{
    if(error instanceof z.ZodError) {res.status(400).json({error:'Check the submitted fields.',details:error.issues.map(i=>({field:i.path.join('.'),message:i.message}))});return;}
    if(error instanceof AppError) {res.status(error.status).json({error:error.message});return;}
    res.status(500).json({error:'The request could not be completed. Refresh and try again.'});
  };
  app.use(errors);return app;
}
