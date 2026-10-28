import {Store} from '../server/db';
import {seedCatalogue} from '../server/db';
const store=new Store(process.env.DATABASE_URL_UNPOOLED||process.env.DATABASE_URL);
try{await store.migrate();await seedCatalogue(store);console.log('AlphaQ PostgreSQL schema and catalogue are ready.');}finally{await store.close();}
