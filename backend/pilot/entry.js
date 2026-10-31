const {migrate}=require('./cli');
const {createDb}=require('./db');
const {validateConfig}=require('./config');
async function start(){validateConfig();const db=createDb();try{await migrate(db);}finally{await db.destroy();}await require('../index').main();}
start().catch(e=>{console.error(e.code||e.message);process.exit(1);});
