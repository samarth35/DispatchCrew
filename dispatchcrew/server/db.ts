import {Pool,types,type PoolClient} from 'pg';
import {AsyncLocalStorage} from 'node:async_hooks';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import type {Customer,Product} from '../shared/types.js';
types.setTypeParser(20,value=>Number(value));
export class Store {
  private savepoint=0;
  readonly schema:string;
  private owns=true;
  pool?:Pool;
  private local?:PGlite;
  ready:Promise<unknown>;
  private context=new AsyncLocalStorage<{client:any;after:(()=>void)[]}>();
  constructor(path=process.env.DATABASE_URL||'',options?:{schema:string;pool?:Pool;local?:PGlite;ready:Promise<unknown>}){
    this.schema=options?.schema||'public';if(!/^(public|aq_demo_[a-f0-9]{24})$/.test(this.schema))throw Error('Invalid workspace namespace.');
    if(options){this.pool=options.pool;this.local=options.local;this.ready=options.ready;this.owns=false;return;}
    if(path===':memory:'){this.local=new PGlite();this.ready=this.local.exec(readFileSync(resolve('server/migrations/001-initial.sql'),'utf8'));return;}
    if(!path.startsWith('postgres'))throw new Error('DATABASE_URL must point to the AlphaQ Postgres database.');
    this.pool=new Pool({connectionString:path,max:5,idleTimeoutMillis:5000,connectionTimeoutMillis:20000});
    this.pool.on('error',()=>{});
    this.ready=Promise.resolve();
  }
  fork(schema:string){return new Store('',{schema,pool:this.pool,local:this.local,ready:this.ready});}
  async migrate(){const sql=readFileSync(resolve('server/migrations/001-initial.sql'),'utf8');await this.transaction(async()=>{await this.query(sql);});}
  private async query(sql:string,values:any[]=[]):Promise<{rows:any[];rowCount?:number;affectedRows?:number}>{await this.ready;const target=this.context.getStore()?.client||this.local||this.pool!;if(this.local&&values.length===0&&sql.includes(';')){await target.exec(sql);return {rows:[]};}return target.query(sql,values);}
  private sql(sql:string){let n=0;let text=sql.replace(/\?/g,()=>'$'+(++n)).replace(/AS 'index'/g,'AS "index"').replace(/\bAS (\w*[A-Z]\w*)/g,'AS "$1"').replace(/GROUP_CONCAT\(name, ', '\)/g,"STRING_AGG(name, ', ')").replace(/ORDER BY rowid DESC/g,'ORDER BY created_at DESC').replace(/ORDER BY rowid/g,'ORDER BY id').replace(/GROUP BY p.id/g,'GROUP BY p.id,i.on_hand,i.reserved').replace(/COUNT\(\*\)/g,'COUNT(*)::int').replace(/SUM\(l.quantity\)/g,'SUM(l.quantity)::int');if(this.schema!=='public'){const names='customers|products|inventory|orders|lines|runs|tasks|events|approvals|reservations|dispatches|messages|approved_substitutions|shortage_choice_receipts|order_revisions|business_settings|users|sessions|account_invites|auth_attempts|security_events|billing_subscription|order_usage|billing_checkouts';text=text.replace(new RegExp('\\b(FROM|JOIN|INTO|UPDATE|REFERENCES)\\s+('+names+')\\b','gi'),(_m,keyword,name)=>keyword+' "'+this.schema+'".'+name).replace(new RegExp('::('+names+')\\b','g'),(_m,name)=>'::"'+this.schema+'".'+name);}return text;}
  async get<T=any>(sql:string,...values:any[]):Promise<T|undefined>{return (await this.query(this.sql(sql),values)).rows[0];}
  async all<T=any>(sql:string,...values:any[]):Promise<T[]>{return (await this.query(this.sql(sql),values)).rows;}
  async run(sql:string,...values:any[]){const result=await this.query(this.sql(sql),values);return {changes:result.rowCount??result.affectedRows??0};}
  async exec(sql:string){await this.query(sql);}
  afterCommit(fn:()=>void){const tx=this.context.getStore();if(tx)tx.after.push(fn);else this.context.exit(fn);}
  async transaction<T>(fn:()=>T|Promise<T>):Promise<T>{
    const existing=this.context.getStore();if(existing){const name='aq_sp_'+(++this.savepoint),count=existing.after.length;await existing.client.query('SAVEPOINT '+name);try{const value=await fn();await existing.client.query('RELEASE SAVEPOINT '+name);return value;}catch(error){existing.after.splice(count);await existing.client.query('ROLLBACK TO SAVEPOINT '+name);throw error;}}
    await this.ready;
    if(this.local){const after:(()=>void)[]=[];let preserved:unknown;const value=await this.local.transaction(async client=>{await client.exec(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"; SET LOCAL search_path TO "${this.schema}"`);try{return await this.context.run({client,after},async()=>fn());}catch(error){if((error as {preserveChanges?:boolean}).preserveChanges){preserved=error;return undefined;}throw error;}});for(const task of after)this.context.exit(task);if(preserved)throw preserved;return value as T;}
    const client=await this.pool!.connect(),after:(()=>void)[]=[];
    try{await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',['alphaq:'+this.schema]);await client.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"; SET LOCAL search_path TO "${this.schema}"`);const value=await this.context.run({client,after},fn);await client.query('COMMIT');for(const task of after)this.context.exit(task);return value;}
    catch(error){if((error as {preserveChanges?:boolean}).preserveChanges){await client.query('COMMIT');for(const task of after)this.context.exit(task);}else await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  async customers():Promise<Customer[]>{return (await this.all('SELECT * FROM customers ORDER BY name'));}
  async products():Promise<Product[]>{return (await this.all('SELECT p.*,i.on_hand AS onHand,i.reserved,i.on_hand-i.reserved AS available FROM products p JOIN inventory i ON i.product_id=p.id ORDER BY p.name')).map(p=>({...p,aliases:JSON.parse(p.aliases)}));}
  async close(){if(!this.owns)return;await this.ready;if(this.local)await this.local.close();else await this.pool!.end();}
}
export async function seedCatalogue(store: Store) {
  if ((await store.get('SELECT id FROM customers LIMIT 1'))) { (await seedSubstitutions(store)); return; }
  (await store.transaction(async () => {
    for (const c of [
      ['acme', 'Acme Studio', '14 AB Road, Indore, MP 452001'], ['paperplane', 'Paperplane Co', '8 Old Palasia, Indore, MP 452001'],
      ['northstar', 'Northstar Office', '21 Vijay Nagar, Indore, MP 452010'], ['cedar', 'Cedar Workspace', '6 New Palasia, Indore, MP 452001'], ['form', 'Form & Field', '17 Saket Nagar, Indore, MP 452018'],
    ]) (await store.run('INSERT INTO customers VALUES(?,?,?)', ...c));
    const products: [string,string,string,number,string[],number][] = [
      ['nb-a5','A5 notebook','NB-A5',12000,['a5 notebook','a5 notebooks','notebook','notebooks'],120],
      ['nb-a4','A4 notebook','NB-A4',18000,['a4 notebook','a4 notebooks','notebook','notebooks'],65],
      ['org-black','Black desk organiser','ORG-BLK',50000,['black desk organiser','black desk organisers','black desk organizer','black desk organizers','desk organiser','desk organisers','organiser','organisers'],60],
      ['org-white','White desk organiser','ORG-WHT',50000,['white desk organiser','white desk organisers','white desk organizer','white desk organizers','desk organiser','desk organisers','organiser','organisers'],8],
      ['pen-blue','Blue pen pack','PEN-BLU',15000,['blue pen pack','blue pen packs','blue pens'],200],
      ['paper-a4','A4 paper ream','PPR-A4',35000,['a4 paper','a4 paper ream','a4 paper reams','paper ream','paper reams'],35],
      ['folder','Document folder','FLD-DOC',8000,['document folder','document folders','folder','folders'],150],
      ['stapler','Desktop stapler','STP-DESK',22000,['desktop stapler','desktop staplers','stapler','staplers'],4],
    ];
    for (const [id,name,sku,price,aliases,qty] of products) {
      (await store.run('INSERT INTO products VALUES(?,?,?,?,?)', id,name,sku,price,JSON.stringify(aliases)));
      (await store.run('INSERT INTO inventory(product_id,on_hand) VALUES(?,?)',id,qty));
    }
  }));
  (await seedSubstitutions(store));
}
async function seedSubstitutions(store: Store) {
  for (const [from,to,reason] of [
    ['nb-a5','nb-a4','A4 is a larger paper size than A5. Please check that it suits your needs.'],
    ['nb-a4','nb-a5','A5 is a smaller paper size than A4. Please check that it suits your needs.'],
    ['org-black','org-white','Same organiser type, different colour: white instead of black.'],
    ['org-white','org-black','Same organiser type, different colour: black instead of white.'],
  ]) (await store.run(`INSERT INTO approved_substitutions SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM products WHERE id=?) AND EXISTS(SELECT 1 FROM products WHERE id=?) ON CONFLICT DO NOTHING`,from,to,reason,from,to));
}
