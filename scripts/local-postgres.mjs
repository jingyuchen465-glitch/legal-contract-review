import { startPostgres } from './postgres-runtime.mjs';
import pg from 'pg';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const local = path.join(root, '.local'); await fs.mkdir(local, { recursive: true });
const secretFile = path.join(local, 'postgres.json');
let credentials;
try { credentials = JSON.parse(await fs.readFile(secretFile, 'utf8')); }
catch { credentials = { user: 'legalagent', password: crypto.randomBytes(32).toString('hex'), port: 55432 }; await fs.writeFile(secretFile, JSON.stringify(credentials), { flag: 'wx', mode: 0o600 }); }
const databaseDir = path.join(process.env.LOCALAPPDATA || local, 'LegalAgentDev', crypto.createHash('sha256').update(root).digest('hex').slice(0,12));
await fs.mkdir(path.dirname(databaseDir), { recursive: true });
const db = await startPostgres({ databaseDir, ...credentials });
const client=new pg.Client({host:'127.0.0.1',...credentials,database:'postgres'});await client.connect();
try { await client.query('CREATE DATABASE legalagent'); } catch(e) {if(e.code!=='42P04')throw e;}finally{await client.end();}
const envFile = path.join(root, '.env');
if (!await fs.stat(envFile).catch(() => null)) {
  const env = `NODE_ENV=development\nHOST=127.0.0.1\nPORT=3000\nDATABASE_URL=postgres://${credentials.user}:${credentials.password}@127.0.0.1:${credentials.port}/legalagent\nDATA_ROOT=${path.join(local, 'data').replaceAll('\\', '/')}\nSESSION_SECRET=${crypto.randomBytes(32).toString('hex')}\nTOKEN_SECRET=${crypto.randomBytes(32).toString('hex')}\nPUBLIC_URL=http://localhost:8080\nDINGTALK_ENABLED=false\n`;
  await fs.writeFile(envFile, env, { flag: 'wx', mode: 0o600 });
}
console.log('本机开发 PostgreSQL 已启动（仅 127.0.0.1:55432）。配置保存在忽略文件 .env。');
console.log('另一终端执行 npm run db:migrate，再设置 BOOTSTRAP_PASSWORD 并执行 npm run bootstrap。');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await db.stop(); process.exit(0); });
setInterval(() => {}, 60000);
