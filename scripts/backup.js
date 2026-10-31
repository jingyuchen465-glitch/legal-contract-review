const {createDb}=require('../backend/pilot/db');
const {config,validateConfig}=require('../backend/pilot/config');
const {createBackup,restoreBackup}=require('../backend/pilot/backup');
async function main(){validateConfig();const restore=process.argv[2]==='restore';const db=createDb(restore?process.env.RESTORE_DATABASE_URL:config.databaseUrl);try{if(restore){const result=await restoreBackup(db,{directory:process.env.BACKUP_DIRECTORY,databaseUrl:process.env.RESTORE_DATABASE_URL,targetRoot:process.env.RESTORE_DATA_ROOT});console.log(JSON.stringify(result));}else{const result=await createBackup(db);console.log('备份完成：'+result.directory);}}finally{await db.destroy();}}
main().catch(e=>{console.error(e.message);process.exit(1);});
