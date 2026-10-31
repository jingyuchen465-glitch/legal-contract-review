const { config, validateConfig } = require('./config');
const { createDb } = require('./db');
const { createQueue } = require('./queue');
const { manageIntegration, processIntegration } = require('./dingtalk');
async function main() {
  validateConfig(); const db = createDb(config.databaseUrl);
  const queue = await createQueue(db, { integrationHandler: id => processIntegration(db, id) });
  const integration = manageIntegration(db); console.log('Legal Agent worker ready');
  const stopBackup = require('./backup').scheduleBackup(db);
  const heartbeat = setInterval(async () => { try { const value=JSON.stringify({lastSeen:new Date().toISOString()});await db('la_settings').insert({key:'worker_heartbeat',value}).onConflict('key').merge({value,updated_at:db.fn.now()}); } catch { console.error('worker_heartbeat_failed'); } },30000);
  const stop = async () => { clearInterval(heartbeat); stopBackup(); await integration.stop(); await queue.stop(); await db.destroy(); process.exit(0); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
if (require.main === module) main().catch(e => { console.error(e.code || e.message); process.exit(1); });
module.exports = { main };
