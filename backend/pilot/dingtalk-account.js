const { randomBytes } = require('node:crypto');
const express = require('express');
const { z } = require('zod');
const { config } = require('./config');
const { dingConfig, fingerprint } = require('./settings');
const { requireRole, audit, hasRole } = require('./auth');
const { wrap, fail } = require('./errors');

const connectionHash = c => fingerprint([c.clientId, c.secret]);
const callbackUrl = () => new URL('/dingtalk/callback', config.publicUrl).href;

async function startBinding(db, user) {
  const connection = await dingConfig(db);
  if (!connection.clientId || !connection.secret) fail(422, 'DING_NOT_CONFIGURED', '请先由管理员保存钉钉应用凭据');
  const state = randomBytes(32).toString('hex');
  await db.transaction(async trx => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['settings:dingtalk_connection']);
    await trx('la_dingtalk_binding_requests').where('expires_at', '<', trx.fn.now()).delete();
    await trx('la_dingtalk_binding_requests').where({ user_id: user.id }).delete();
    await trx('la_dingtalk_binding_requests').insert({ state_hash: fingerprint(state), user_id: user.id, connection_hash: connectionHash(connection), expires_at: new Date(Date.now() + 10 * 60000) });
  });
  const url = new URL('https://login.dingtalk.com/oauth2/auth');
  for (const [key, value] of Object.entries({ client_id: connection.clientId, response_type: 'code', redirect_uri: callbackUrl(), scope: 'openid', state, prompt: 'consent' })) url.searchParams.set(key, value);
  return { url: url.href };
}

// The app-token lookup maps the authorized UnionID into this application's enterprise.
// Neither a caller-supplied UserID nor the event's staffId can establish a binding.
async function resolveIdentity(connection, code, { fetchImpl = fetch } = {}) {
  async function json(url, options) {
    let response;
    try { response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(20000) }); }
    catch { fail(503, 'DING_BIND_NETWORK', '钉钉账号验证暂时不可用，请稍后重新绑定'); }
    let body; try { body = await response.json(); } catch { fail(422, 'DING_BIND_RESPONSE', '钉钉账号验证返回异常，请重新绑定'); }
    if (!response.ok || body.errcode) fail(422, 'DING_BIND_ACCESS', '无法确认企业钉钉账号，请检查授权、通讯录权限及应用可访问范围');
    return body;
  }
  const post = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const userToken = await json('https://api.dingtalk.com/v1.0/oauth2/userAccessToken', post({ clientId: connection.clientId, clientSecret: connection.secret, code, grantType: 'authorization_code' }));
  if (!userToken.accessToken) fail(422, 'DING_BIND_TOKEN', '钉钉授权已失效，请重新绑定');
  const profile = await json('https://api.dingtalk.com/v1.0/contact/users/me', { headers: { 'x-acs-dingtalk-access-token': userToken.accessToken } });
  if (!profile.unionId) fail(422, 'DING_BIND_IDENTITY', '钉钉未返回账号标识，请检查个人信息读取权限');
  const appToken = await json('https://api.dingtalk.com/v1.0/oauth2/accessToken', post({ appKey: connection.clientId, appSecret: connection.secret }));
  if (!appToken.accessToken) fail(422, 'DING_BIND_APP', '钉钉应用鉴权失败，请联系管理员');
  const member = await json(`https://oapi.dingtalk.com/topapi/user/getbyunionid?access_token=${encodeURIComponent(appToken.accessToken)}`, post({ unionid: profile.unionId }));
  const userId = member.result?.userid;
  if (!userId) fail(422, 'DING_BIND_MEMBERSHIP', '当前钉钉账号不在此应用可访问的企业范围内');
  return { userId: String(userId), displayName: String(profile.nick || '钉钉成员').slice(0, 200) };
}

async function completeBinding(db, user, input, { resolve = resolveIdentity } = {}) {
  const { code, state } = z.object({ code: z.string().min(1).max(2000), state: z.string().regex(/^[a-f0-9]{64}$/) }).parse(input);
  const connection = await dingConfig(db), hash = connectionHash(connection);
  const request = await db('la_dingtalk_binding_requests').where({ state_hash: fingerprint(state), user_id: user.id }).where('expires_at', '>', db.fn.now()).first();
  if (!request || request.connection_hash !== hash) fail(409, 'DING_BIND_STATE', '绑定请求已失效或应用已变更，请重新开始绑定');
  const identity = await resolve(connection, code);
  if (!identity.userId) fail(422, 'DING_BIND_IDENTITY', '无法确认企业钉钉账号');
  await db.transaction(async trx => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['settings:dingtalk_connection']);
    const consumed = await trx('la_dingtalk_binding_requests').where({ state_hash: fingerprint(state), user_id: user.id }).where('expires_at', '>', trx.fn.now()).delete().returning('*');
    if (!consumed.length) fail(409, 'DING_BIND_STATE', '绑定请求已取消、过期或已使用，请重新开始绑定');
    if (connectionHash(await dingConfig(trx)) !== hash) fail(409, 'DING_BIND_APP_CHANGED', '应用已变更，请重新绑定');
    const currentUser = await trx('la_users').where({ id: user.id, active: true }).forShare().first();
    if (!hasRole(currentUser, 'business', 'legal')) fail(403, 'DING_BIND_ROLE', '接收账号需具有系统管理员权限');
    const duplicate = await trx('la_dingtalk_accounts').where({ client_id: connection.clientId, ding_user_id: identity.userId }).whereNot({ user_id: user.id }).first();
    if (duplicate) fail(409, 'DING_ACCOUNT_BOUND', '这个钉钉账号已绑定其他工作台账号，请联系管理员核对');
    await trx('la_dingtalk_accounts').insert({ user_id: user.id, client_id: connection.clientId, ding_user_id: identity.userId, display_name: identity.displayName }).onConflict('user_id').merge({ client_id: connection.clientId, ding_user_id: identity.userId, display_name: identity.displayName, updated_at: trx.fn.now() });
    await audit(trx, user, 'dingtalk.account.bind', user.id);
  });
  return { ok: true };
}

function accountRouter(db) {
  const r = express.Router();
  r.use('/dingtalk/account', requireRole('business', 'legal'));
  r.get('/dingtalk/account', wrap(async (req, res) => {
    const connection = await dingConfig(db), account = await db('la_dingtalk_accounts').where({ user_id: req.user.id, client_id: connection.clientId || '' }).first();
    res.set('Cache-Control', 'no-store').json({ configured: !!connection.clientId && !!connection.secret, enabled: connection.enabled, account: account ? { displayName: account.display_name, boundAt: account.updated_at } : null });
  }));
  r.post('/dingtalk/account/start', wrap(async (req, res) => res.json(await startBinding(db, req.user))));
  r.post('/dingtalk/account/complete', wrap(async (req, res) => res.json(await completeBinding(db, req.user, req.body))));
  r.delete('/dingtalk/account', wrap(async (req, res) => {
    await db.transaction(async trx => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['settings:dingtalk_connection']);
      await trx('la_dingtalk_accounts').where({ user_id: req.user.id }).delete();
      await trx('la_dingtalk_binding_requests').where({ user_id: req.user.id }).delete();
      await audit(trx, req.user, 'dingtalk.account.unbind', req.user.id);
    });
    res.json({ ok: true });
  }));
  return r;
}

module.exports = { accountRouter, startBinding, completeBinding, resolveIdentity, callbackUrl };
