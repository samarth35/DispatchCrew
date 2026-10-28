import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Customer, Product } from '../shared/types';

export class Store {
  private transactionDepth = 0;
  db: DatabaseSync;
  constructor(path = process.env.DATABASE_PATH || './data/dispatchcrew.sqlite') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS customers(id TEXT PRIMARY KEY, name TEXT NOT NULL, address TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS products(id TEXT PRIMARY KEY, name TEXT NOT NULL, sku TEXT UNIQUE NOT NULL, price INTEGER NOT NULL CHECK(price>=0), aliases TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inventory(product_id TEXT PRIMARY KEY REFERENCES products(id), on_hand INTEGER NOT NULL CHECK(on_hand>=0), reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved>=0 AND reserved<=on_hand));
      CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, reference TEXT NOT NULL, customer_id TEXT NOT NULL REFERENCES customers(id), input_hash TEXT NOT NULL, message TEXT NOT NULL, address TEXT NOT NULL, token TEXT UNIQUE NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, total INTEGER NOT NULL DEFAULT 0, questions TEXT NOT NULL DEFAULT '[]', intake TEXT, restock TEXT NOT NULL DEFAULT '[]', error TEXT, failure_stage TEXT, faults_remaining INTEGER NOT NULL DEFAULT 0, waiting_stock INTEGER NOT NULL DEFAULT 0, ai_source TEXT NOT NULL DEFAULT 'live', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(customer_id,reference));
      CREATE TABLE IF NOT EXISTS lines(order_id TEXT NOT NULL REFERENCES orders(id), line_index INTEGER NOT NULL, product_id TEXT REFERENCES products(id), name TEXT NOT NULL, quantity INTEGER CHECK(quantity>0), unit_price INTEGER NOT NULL, PRIMARY KEY(order_id,line_index));
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, order_id TEXT UNIQUE NOT NULL REFERENCES orders(id), state TEXT NOT NULL, stage TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), role TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, output TEXT NOT NULL DEFAULT 'null', UNIQUE(run_id,role,title));
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL REFERENCES orders(id), role TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL, visibility TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approvals(id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), version INTEGER NOT NULL, snapshot TEXT NOT NULL, decision TEXT NOT NULL DEFAULT 'pending', reason TEXT, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reservations(execution_key TEXT NOT NULL, product_id TEXT NOT NULL REFERENCES products(id), order_id TEXT NOT NULL REFERENCES orders(id), quantity INTEGER NOT NULL CHECK(quantity>0), UNIQUE(execution_key,product_id));
      CREATE TABLE IF NOT EXISTS dispatches(id TEXT PRIMARY KEY, order_id TEXT UNIQUE NOT NULL REFERENCES orders(id), execution_key TEXT UNIQUE NOT NULL, reference TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), execution_key TEXT UNIQUE NOT NULL, body TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS approved_substitutions(product_id TEXT NOT NULL REFERENCES products(id), replacement_id TEXT NOT NULL REFERENCES products(id), reason TEXT NOT NULL, PRIMARY KEY(product_id,replacement_id), CHECK(product_id<>replacement_id));
      CREATE TABLE IF NOT EXISTS shortage_choice_receipts(order_id TEXT NOT NULL REFERENCES orders(id), quote_id TEXT NOT NULL, request_hash TEXT NOT NULL, to_version INTEGER NOT NULL, PRIMARY KEY(order_id,quote_id));
      CREATE TABLE IF NOT EXISTS order_revisions(id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), from_version INTEGER NOT NULL, to_version INTEGER NOT NULL, kind TEXT NOT NULL, before_json TEXT NOT NULL, after_json TEXT NOT NULL, at TEXT NOT NULL, UNIQUE(order_id,to_version));
      CREATE INDEX IF NOT EXISTS event_order_idx ON events(order_id,id);`);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS business_settings(id INTEGER PRIMARY KEY CHECK(id=1), name TEXT NOT NULL DEFAULT 'DispatchCrew warehouse', customer_signup INTEGER NOT NULL DEFAULT 1);
      INSERT OR IGNORE INTO business_settings(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL COLLATE NOCASE, name TEXT NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','manager','staff','customer')), customer_id TEXT REFERENCES customers(id), disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)), created_at TEXT NOT NULL, CHECK((role='customer' AND customer_id IS NOT NULL) OR (role<>'customer' AND customer_id IS NULL)));
      CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf_token TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS session_user_idx ON sessions(user_id);
      CREATE TABLE IF NOT EXISTS account_invites(id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, email TEXT NOT NULL COLLATE NOCASE, role TEXT NOT NULL CHECK(role IN ('manager','staff','customer')), customer_id TEXT REFERENCES customers(id), created_by TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL, used_at TEXT, revoked_at TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_attempts(bucket TEXT PRIMARY KEY, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS security_events(id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT REFERENCES users(id), action TEXT NOT NULL, detail TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS billing_subscription(id INTEGER PRIMARY KEY CHECK(id=1), plan_id TEXT NOT NULL DEFAULT 'free', version INTEGER NOT NULL DEFAULT 1);
      INSERT OR IGNORE INTO billing_subscription(id) VALUES(1);
      CREATE TABLE IF NOT EXISTS order_usage(order_id TEXT PRIMARY KEY REFERENCES orders(id), at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS billing_checkouts(id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, plan_id TEXT NOT NULL, amount INTEGER NOT NULL, base_version INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, completed_at TEXT);
      INSERT OR IGNORE INTO order_usage SELECT id,created_at FROM orders WHERE ai_source<>'seeded';
    `);
  }
  get<T = any>(sql: string, ...values: SQLInputValue[]): T | undefined { return this.db.prepare(sql).get(...values) as T | undefined; }
  all<T = any>(sql: string, ...values: SQLInputValue[]): T[] { return this.db.prepare(sql).all(...values) as T[]; }
  run(sql: string, ...values: SQLInputValue[]) { return this.db.prepare(sql).run(...values); }
  transaction<T>(fn: () => T): T {
    if (this.transactionDepth) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.transactionDepth++;
    try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } finally { this.transactionDepth--; }
  }
  customers(): Customer[] { return this.all('SELECT * FROM customers ORDER BY name'); }
  products(): Product[] { return this.all(`SELECT p.*, i.on_hand AS onHand, i.reserved, i.on_hand-i.reserved AS available FROM products p JOIN inventory i ON i.product_id=p.id ORDER BY p.name`).map(p => ({ ...p, aliases: JSON.parse(p.aliases) })); }
  close() { this.db.close(); }
}
export function seedCatalogue(store: Store) {
  if (store.get('SELECT id FROM customers LIMIT 1')) { seedSubstitutions(store); return; }
  store.transaction(() => {
    for (const c of [
      ['acme', 'Acme Studio', '14 AB Road, Indore, MP 452001'], ['paperplane', 'Paperplane Co', '8 Old Palasia, Indore, MP 452001'],
      ['northstar', 'Northstar Office', '21 Vijay Nagar, Indore, MP 452010'], ['cedar', 'Cedar Workspace', '6 New Palasia, Indore, MP 452001'], ['form', 'Form & Field', '17 Saket Nagar, Indore, MP 452018'],
    ]) store.run('INSERT INTO customers VALUES(?,?,?)', ...c);
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
      store.run('INSERT INTO products VALUES(?,?,?,?,?)', id,name,sku,price,JSON.stringify(aliases));
      store.run('INSERT INTO inventory(product_id,on_hand) VALUES(?,?)',id,qty);
    }
  });
  seedSubstitutions(store);
}
function seedSubstitutions(store: Store) {
  for (const [from,to,reason] of [
    ['nb-a5','nb-a4','A4 is a larger paper size than A5. Please check that it suits your needs.'],
    ['nb-a4','nb-a5','A5 is a smaller paper size than A4. Please check that it suits your needs.'],
    ['org-black','org-white','Same organiser type, different colour: white instead of black.'],
    ['org-white','org-black','Same organiser type, different colour: black instead of white.'],
  ]) store.run(`INSERT OR IGNORE INTO approved_substitutions SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM products WHERE id=?) AND EXISTS(SELECT 1 FROM products WHERE id=?)`,from,to,reason,from,to);
}
