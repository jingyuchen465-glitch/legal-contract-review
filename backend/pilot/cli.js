const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { config, validateConfig } = require('./config');
const { createDb } = require('./db');
const { hashPassword, audit } = require('./auth');
const { seedDrafts } = require('./seeds');
const { initializeDirectories } = require('./storage');
async function migrate(db) { return db.migrate.latest({ directory: path.join(__dirname, 'migrations'), tableName: 'la_migrations' }); }
async function main() {
  validateConfig(); const db = createDb();
  try {
    await migrate(db); await initializeDirectories();
    if (process.argv[2] === 'bootstrap') {
      const username = process.env.BOOTSTRAP_USERNAME || 'admin', password = process.env.BOOTSTRAP_PASSWORD;
      if (!password) throw new Error('请在环境中设置 BOOTSTRAP_PASSWORD（至少12位），不会生成默认密码');
      if (!(await db('la_users').where({ username }).first())) {
        const user = { id: randomUUID(), username, display_name: process.env.BOOTSTRAP_NAME || '系统管理员', password_hash: await hashPassword(password), roles: JSON.stringify(['admin']), department: '' };
        await db('la_users').insert(user); await audit(db, user, 'user.bootstrap', user.id); console.log('管理员已创建，可直接提交合同、复核、维护规则和发布');
      } else console.log('账号已存在，未覆盖密码或角色');
      await seedDrafts(db);
    } else if (process.argv[2] === 'demo') {
      await seedDrafts(db); console.log('已建立示例规则草稿，尚未发布。使用工作台上传虚构合同进行试用。');
    } else console.log('数据库迁移完成，已有数据保留');
  } finally { await db.destroy(); }
}
if (require.main === module) main().catch(e => { console.error(e.code || e.message); process.exit(1); });
module.exports = { migrate };
