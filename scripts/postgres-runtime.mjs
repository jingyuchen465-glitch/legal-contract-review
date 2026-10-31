import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import pg from 'pg';
const exec = promisify(execFile), require = createRequire(import.meta.url);
export async function startPostgres({ databaseDir, user, password, port }) {
  if (process.platform !== 'win32') {
    const { default: EmbeddedPostgres } = await import('embedded-postgres');
    const database = new EmbeddedPostgres({ databaseDir, user, password, port, authMethod: 'scram-sha-256', initdbFlags: ['--locale=C','--encoding=UTF8'], postgresFlags: ['-h','127.0.0.1'], onLog:()=>{},onError:()=>{} });
    if (!await fs.stat(path.join(databaseDir,'PG_VERSION')).catch(()=>null)) await database.initialise(); await database.start(); return { stop:()=>database.stop() };
  }
  // PostgreSQL's Windows bootstrap cannot read a non-ASCII binary path under UTF-8.
  // Copy the packaged native distribution to a dedicated ASCII cache without changing system services.
  const binaryModule = require.resolve('@embedded-postgres/windows-x64');
  const source = path.resolve(path.dirname(binaryModule),'../native');
  const runtime = path.join(process.env.LOCALAPPDATA || os.tmpdir(),'LegalAgentDev','runtime-18.4.0-beta.17');
  if (!await fs.stat(path.join(runtime,'.ready')).catch(()=>null)) { await fs.mkdir(runtime,{recursive:true}); await fs.cp(source,runtime,{recursive:true}); await fs.writeFile(path.join(runtime,'.ready'),'packaged native runtime'); }
  const bin = name => path.join(runtime,'bin',`${name}.exe`);
  if (!await fs.stat(path.join(databaseDir,'PG_VERSION')).catch(()=>null)) {
    await fs.mkdir(path.dirname(databaseDir),{recursive:true});
    const passwordFile = path.join(os.tmpdir(),`legal-pg-${process.pid}-${port}.txt`);
    await fs.writeFile(passwordFile,password+'\n',{flag:'wx',mode:0o600});
    try { await exec(bin('initdb'),['-D',databaseDir,'--auth=scram-sha-256',`--username=${user}`,`--pwfile=${passwordFile}`,'--locale=C','--encoding=UTF8'],{windowsHide:true,timeout:60000,env:{...process.env,LC_ALL:'C'}}); } finally { await fs.unlink(passwordFile); }
  }
  const processHandle = spawn(bin('postgres'),['-D',databaseDir,'-h','127.0.0.1','-p',String(port)],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  let exited=false, diagnostic=''; processHandle.on('error',e=>{diagnostic=e.code;exited=true;});processHandle.on('exit',()=>{exited=true;});processHandle.stderr.on('data',c=>{diagnostic=(diagnostic+c).slice(-2000);});
  let ready=false;
  for(let attempt=0;attempt<100;attempt++){if(exited)throw new Error('PostgreSQL startup failed: '+diagnostic); const client=new pg.Client({host:'127.0.0.1',port,user,password,database:'postgres',connectionTimeoutMillis:500});try{await client.connect();await client.query('select 1');ready=true;break;}catch{}finally{await client.end().catch(()=>{});}await new Promise(r=>setTimeout(r,300));}
  if(!ready){processHandle.kill();throw new Error('PostgreSQL startup timed out');}
  return { stop:()=>exec(bin('pg_ctl'),['-D',databaseDir,'stop','-m','fast','-w'],{windowsHide:true,timeout:30000}), binary:bin };
}
