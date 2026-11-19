const http = require('node:http');
const { setupRealtime } = require('./pilot/realtime');
const { config, validateConfig } = require('./pilot/config');
const { createDb } = require('./pilot/db');
const { createApp } = require('./pilot/app');
const { initializeDirectories } = require('./pilot/storage');
async function main() {
  validateConfig(); const db = createDb(config.databaseUrl); await db.raw('select 1'); await initializeDirectories();
  const { app, sessionMiddleware } = createApp(db); const server = http.createServer(app);
  const realtime = setupRealtime(server, db, sessionMiddleware);
  server.listen(config.port, config.host, () => console.log(`Legal Agent listening http://${config.host}:${config.port}`));
  const stop = async () => { await realtime.close(); await db.destroy(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
if (require.main === module) main().catch(e => { console.error(e.code || e.message); process.exit(1); });
module.exports = { main };
