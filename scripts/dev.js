const { spawn } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(root, '.env'), quiet: true });
const { Client } = require('pg');
const { config } = require('../backend/pilot/config');
const { ensureConverter, stopChild } = require('./converter-startup');
const children = [];
let stopping = false;
function stop() { if (stopping) return; stopping = true; for (const child of children) stopChild(child); }
function track(child) {
  children.push(child);
  child.on('error', () => { process.exitCode = 1; stop(); });
  child.on('exit', () => { if (!stopping) { process.exitCode = 1; stop(); } });
}
async function main() {
  const client = new Client({ connectionString: config.databaseUrl, connectionTimeoutMillis: 3000 });
  try { await client.connect(); await client.query('SELECT 1'); }
  catch { throw Error('数据库不可达，请先运行 npm run db:local；后台任务尚未启动。'); }
  finally { await client.end().catch(() => {}); }
  const converter = await ensureConverter(root);
  if (converter) track(converter);
  if (stopping) { if (converter) stopChild(converter); return; }
  for (const [args, cwd] of [
    [['backend/index.js'], root],
    [['backend/pilot/worker.js'], root],
    [[path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1'], path.join(root, 'frontend')],
  ]) track(spawn(process.execPath, args, { cwd, stdio: 'inherit', windowsHide: true }));
}
process.once('SIGINT', stop); process.once('SIGTERM', stop);
main().catch(error => { console.error(error.message); process.exitCode = 1; stop(); });
