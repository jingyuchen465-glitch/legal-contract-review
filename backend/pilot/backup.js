const fs=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const crypto=require('node:crypto');
const {config}=require('./config');
function run(binary,args,url){const u=new URL(url);return new Promise((resolve,reject)=>{const child=spawn(binary,args,{windowsHide:true,stdio:['ignore','ignore','pipe'],env:{...process.env,PGHOST:u.hostname,PGPORT:u.port||'5432',PGUSER:decodeURIComponent(u.username),PGPASSWORD:decodeURIComponent(u.password),PGDATABASE:decodeURIComponent(u.pathname.slice(1))}});let code;child.on('error',e=>reject(new Error(`备份工具不可用：${e.code}`)));child.stderr.on('data',()=>{});child.on('exit',status=>status===0?resolve():reject(new Error(`数据库备份工具退出：${status}`)));});}
async function inventory(dir,prefix=''){const result=[];for(const item of await fs.readdir(dir,{withFileTypes:true})){const relative=path.join(prefix,item.name),target=path.join(dir,item.name);if(item.isSymbolicLink())throw new Error('备份中不允许符号链接');if(item.isDirectory())result.push(...await inventory(target,relative));else if(item.isFile()){const data=await fs.readFile(target);result.push({path:relative.replaceAll('\\','/'),sha256:crypto.createHash('sha256').update(data).digest('hex'),bytes:data.length});}}return result;}
async function createBackup(db,{dataRoot=config.dataRoot,databaseUrl=config.databaseUrl,dumpPath=process.env.PG_DUMP_PATH||'pg_dump',retentionDays=30}={}){
  const root=path.resolve(dataRoot,'backups');await fs.mkdir(root,{recursive:true});const target=path.join(root,`backup-${new Date().toISOString().replace(/[:.]/g,'-')}-${crypto.randomBytes(3).toString('hex')}`);await fs.mkdir(target);
  try{
    await run(dumpPath,['--format=custom','--no-owner','--file',path.join(target,'database.dump')],databaseUrl);
    await fs.cp(path.join(dataRoot,'objects'),path.join(target,'objects'),{recursive:true});
    const files=await inventory(target);const manifest={version:1,createdAt:new Date().toISOString(),files,encryptedSettingsRequireOriginalTokenSecret:true};await fs.writeFile(path.join(target,'manifest.json'),JSON.stringify(manifest,null,2));
    const previous=(await db('la_settings').where({key:'backup'}).first())?.value||{};const state={...previous,lastSuccess:manifest.createdAt,directory:target,lastError:null};await db('la_settings').insert({key:'backup',value:JSON.stringify(state)}).onConflict('key').merge({value:JSON.stringify(state),updated_at:db.fn.now()});
    for(const item of await fs.readdir(root,{withFileTypes:true})){if(!item.isDirectory()||!/^backup-[\dTZA-Fa-f.-]+$/.test(item.name))continue;const old=path.resolve(root,item.name);if(path.relative(root,old).startsWith('..')||old===target)continue;const stat=await fs.stat(old);if(stat.mtimeMs<Date.now()-retentionDays*86400000&&await fs.stat(path.join(old,'manifest.json')).catch(()=>null))await fs.rm(old,{recursive:true});}
    return{directory:target,manifest};
  }catch(e){const previous=(await db('la_settings').where({key:'backup'}).first())?.value||{};await db('la_settings').insert({key:'backup',value:JSON.stringify({...previous,lastError:e.message,lastAttempt:new Date().toISOString()})}).onConflict('key').merge({value:JSON.stringify({...previous,lastError:e.message,lastAttempt:new Date().toISOString()})});throw e;}
}
async function restoreBackup(db,{directory,databaseUrl,targetRoot,restorePath=process.env.PG_RESTORE_PATH||'pg_restore'}){
  if(!databaseUrl||new URL(databaseUrl).href===new URL(config.databaseUrl).href)throw new Error('必须指定独立的恢复目标数据库，禁止覆盖运行中数据库');
  if(!targetRoot||path.resolve(targetRoot)===path.resolve(config.dataRoot))throw new Error('必须指定独立的空文件目录');
  const root=path.resolve(directory),manifest=JSON.parse(await fs.readFile(path.join(root,'manifest.json'),'utf8'));
  for(const file of manifest.files){const p=path.resolve(root,file.path);if(path.relative(root,p).startsWith('..')||path.isAbsolute(path.relative(root,p)))throw new Error('备份路径越界');const data=await fs.readFile(p);if(crypto.createHash('sha256').update(data).digest('hex')!==file.sha256)throw new Error('备份校验失败');}
  if((await db.raw("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.length)throw new Error('恢复目标数据库必须为空');
  await fs.mkdir(targetRoot,{recursive:true});if((await fs.readdir(targetRoot)).length)throw new Error('恢复文件目录必须为空');
  await run(restorePath,['--no-owner','--no-privileges','--dbname',new URL(databaseUrl).pathname.slice(1),path.join(root,'database.dump')],databaseUrl);
  await fs.cp(path.join(root,'objects'),path.join(targetRoot,'objects'),{recursive:true});
  const missing=[];for(const v of await db('la_versions').select('storage_key','sha256')){const p=path.resolve(targetRoot,v.storage_key);if(path.relative(targetRoot,p).startsWith('..'))throw new Error('恢复文件路径越界');const data=await fs.readFile(p).catch(()=>null);if(!data||crypto.createHash('sha256').update(data).digest('hex')!==v.sha256)missing.push(v.storage_key);}
  if(missing.length)throw new Error('恢复文件完整性校验失败');if(await db.schema.hasTable('la_sessions'))await db('la_sessions').delete();return{restoredAt:new Date().toISOString(),versions:(await db('la_versions')).length};
}
function scheduleBackup(db){let busy=false;const check=async()=>{if(busy)return;busy=true;try{const prior=(await db('la_settings').where({key:'backup'}).first())?.value;const since=prior?.lastSuccess||prior?.lastAttempt;if(!since||Date.now()-new Date(since).getTime()>86400000)await createBackup(db);}catch{console.error('scheduled_backup_failed');}finally{busy=false;}};const timer=setInterval(check,60000);void check();return()=>clearInterval(timer);}
module.exports={createBackup,restoreBackup,scheduleBackup,inventory};
