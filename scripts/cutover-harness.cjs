const {createDb}=require('../backend/pilot/db');
(async()=>{const db=createDb();try{console.log(JSON.stringify(await require('../backend/pilot/agent/cutover').retireLegacy(db,{apply:process.argv.includes('--apply')}),null,2));}finally{await db.destroy();}})().catch(e=>{console.error(e.code||'CUTOVER_FAILED',e.code?e.message:'切换失败');process.exitCode=1;});
