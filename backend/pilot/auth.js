const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { fail } = require('./errors');
const scrypt = promisify(crypto.scrypt);
// Legacy role names remain readable for existing databases and tests. New
// accounts are created as admin-only accounts, and admin is a superuser.
const roles = ['business', 'legal', 'publisher', 'admin'];
async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12) fail(400, 'PASSWORD_POLICY', '密码至少 12 位');
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${(await scrypt(password, salt, 64)).toString('hex')}`;
}
async function verifyPassword(password, stored) {
  const [salt, hex] = stored.split(':');
  const derived = await scrypt(String(password), salt, 64);
  const expected = Buffer.from(hex, 'hex');
  return expected.length === derived.length && crypto.timingSafeEqual(derived, expected);
}
function publicUser(u) { return { id: u.id, username: u.username, displayName: u.display_name, department: u.department, roles: u.roles, active: u.active, revision: u.revision }; }
const hasRole = (user, ...allowed) => !!user && (user.roles.includes('admin') || allowed.some(r => user.roles.includes(r)));
function requireRole(...allowed) { return (req, res, next) => { try { if (!hasRole(req.user, ...allowed)) fail(403, 'FORBIDDEN', '当前角色没有此操作权限'); next(); } catch (e) { next(e); } }; }
function canRead(user, c) {
  return user && (hasRole(user, 'admin') || c.submitter_id === user.id || c.reviewer_id === user.id || (hasRole(user, 'legal') && (user.department === '*' || (user.department && user.department === c.department))));
}
async function accessible(db, user, id, lock = false) {
  let query = db('la_contracts').where({ id }); if (lock) query = query.forUpdate();
  const c = await query.first(); if (!c || !canRead(user, c)) fail(404, 'CONTRACT_NOT_FOUND', '合同不存在或没有访问权限'); return c;
}
function assertRevision(record, revision) { if (!Number.isInteger(revision) || record.revision !== revision) fail(409, 'REVISION_CONFLICT', '记录已更新，请刷新后重试'); }
async function audit(db, actor, action, entityId, details = {}) { await db('la_audit').insert({ actor_id: actor?.id || null, action, entity_id: entityId || null, details: JSON.stringify(details) }); }
module.exports = { roles, hashPassword, verifyPassword, publicUser, hasRole, requireRole, canRead, accessible, assertRevision, audit };
