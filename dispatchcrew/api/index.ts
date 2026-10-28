import type {Request,Response} from 'express';
import {attachDatabasePool,waitUntil} from '@vercel/functions';
import {Store} from '../server/db.js';
import {Workflow} from '../server/workflow.js';
import {OpenRouterProvider} from '../server/ai.js';
import {createApp} from '../server/app.js';

const store=new Store();attachDatabasePool(store.pool!);
const workflow=new Workflow(store,new OpenRouterProvider(),false);
const app=createApp(workflow,promise=>waitUntil(promise));
export default function handler(req:Request,res:Response){return app(req,res);}
