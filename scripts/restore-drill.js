const {randomUUID}=require('node:crypto');
const path=require('node:path');
const fs=require('node:fs/promises');
const {config,validateConfig}=require('../backend/pilot/config');
const {createDb}=require('../backend/pilot/db');
const {createBackup,restoreBackup}=require('../backend/pilot/backup');
async function main(){validateConfig();const source=createDb(),id=randomUUID().replaceAll('-',''),name='legal_drill_'+id,targetRoot=path.resolve(config.dataRoot,'backups','drill-'+id);let target;
try{const backup=await createBackup(source);await source.raw(`CREATE DATABASE "${name}"`);const url=new URL(config.databaseUrl);url.pathname='/'+name;target=createDb(url.href);const result=await restoreBackup(target,{directory:backup.directory,databaseUrl:url.href,targetRoot});const state=(await source('la_settings').where({key:'backup'}).first()).value;await source('la_settings').where({key:'backup'}).update({value:JSON.stringify({...state,restoreTested:true,lastRestoreDrill:result.restoredAt,restoredVersions:result.versions})});console.log('隔离恢复演练通过，已校验数据库与原件哈希，运行页面已记录结果。');}
finally{if(target){await target.destroy();await source.raw(`DROP DATABASE "${name}"`);const base=path.resolve(config.dataRoot,'backups');const relative=path.relative(base,targetRoot);if(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&/^drill-[a-f0-9]+$/.test(path.basename(targetRoot)))await fs.rm(targetRoot,{recursive:true,force:true});}await source.destroy();}}
main().catch(e=>{console.error(e.code||e.message);process.exit(1);});
