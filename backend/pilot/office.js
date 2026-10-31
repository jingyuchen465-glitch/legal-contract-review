const express = require('express');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');
const { z } = require('zod');
const { config } = require('./config');
const { wrap, fail } = require('./errors');
const { accessible, requireRole, hasRole, audit } = require('./auth');
const { addVersion } = require('./contracts');
const storage = require('./storage');
function documentToken(versionId, userId) { return jwt.sign({ versionId, userId }, config.tokenSecret, { algorithm: 'HS256', audience: 'office-document', expiresIn: '15m' }); }
function publicRouter(db) {
  const r = express.Router();
  r.get('/files/:versionId', wrap(async (req, res) => {
    const id = z.string().uuid().parse(req.params.versionId); let user = req.user;
    if (req.query.token) {
      let claims; try { claims = jwt.verify(req.query.token, config.tokenSecret, { algorithms: ['HS256'], audience: 'office-document' }); } catch { fail(401, 'INVALID_DOCUMENT_TOKEN', '文档访问凭证无效或已过期'); }
      if (claims.versionId !== id) fail(403, 'DOCUMENT_SCOPE', '凭证不适用于此版本');
      user = await db('la_users').where({ id: claims.userId, active: true }).first();
    }
    if (!user) fail(401, 'LOGIN_REQUIRED', '请先登录');
    const v = await db('la_versions').where({ id }).first(); if (!v) fail(404, 'FILE_NOT_FOUND', '文件不存在');
    await accessible(db, user, v.contract_id); await audit(db, user, 'document.download', v.contract_id, { versionId: id });
    res.set('Cache-Control', 'private, no-store').type(v.media_type);
    if (req.query.download) res.attachment(v.filename);
    res.send(await storage.read(v.storage_key));
  }));
  r.post('/onlyoffice/callback', wrap(async (req, res) => {
    if (!config.office.secret) fail(503, 'OFFICE_NOT_CONFIGURED', '编辑器未配置');
    let claims; try { claims = jwt.verify(req.body.token || req.headers.authorization?.replace(/^Bearer /, ''), config.office.secret, { algorithms: ['HS256'] }); } catch { fail(401, 'INVALID_OFFICE_SIGNATURE', '编辑器回调签名无效'); }
    const signed = claims.payload || claims;
    if (signed.key !== req.body.key || signed.status !== req.body.status || (req.body.url && signed.url !== req.body.url)) fail(401, 'INVALID_OFFICE_PAYLOAD', '回调内容与签名不一致');
    const session = await db('la_editor_sessions').where({ key: req.body.key }).first();
    if (!session || new Date(session.expires_at) < new Date()) fail(403, 'EDITOR_SESSION_EXPIRED', '编辑会话已失效');
    if (![2, 6].includes(req.body.status)) return res.json({ error: 0 });
    let url; try { url = new URL(req.body.url); } catch { fail(400, 'OFFICE_URL', '保存地址无效'); }
    if (url.origin !== new URL(config.office.internalUrl).origin || url.username || url.password) fail(403, 'OFFICE_URL', '保存地址不属于配置的编辑器');
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
    if (!response.ok) fail(502, 'OFFICE_DOWNLOAD', '无法下载编辑器保存文件');
    const buffers = []; let size = 0;
    for await (const part of response.body) { size += part.length; if (size > 50 * 1024 * 1024) { await response.body.cancel().catch(() => {}); fail(413, 'FILE_TOO_LARGE', '文件超过 50MB'); } buffers.push(Buffer.from(part)); }
    await db.transaction(async trx => {
      const s = await trx('la_editor_sessions').where({ key: session.key }).forUpdate().first();
      const user = await trx('la_users').where({ id: s.user_id, active: true }).first(); if (!hasRole(user, 'legal')) fail(403, 'FORBIDDEN', '编辑权限已失效');
      const c = await accessible(trx, user, s.contract_id, true);
      const buffer = Buffer.concat(buffers), sha256 = storage.sha256(buffer);
      if (await trx('la_editor_saves').where({ editor_key: s.key, sha256 }).first()) return;
      if (c.current_version_id !== s.version_id) fail(409, 'EDITOR_STALE', '合同已有新版本，请重新打开编辑器');
      const v = await trx('la_versions').where({ id: s.version_id }).first();
      const result = await addVersion(trx, c, { originalname: v.filename, buffer }, user.id, 'onlyoffice');
      await trx('la_editor_saves').insert({ editor_key: s.key, sha256, version_id: result.version.id });
      await trx('la_editor_sessions').where({ key: s.key }).update({ version_id: result.version.id });
      await audit(trx, user, 'document.office_save', c.id, { versionId: result.version.id, duplicate: result.duplicate });
    }); res.json({ error: 0 });
  }));
  return r;
}
function privateRouter(db) {
  const r = express.Router();
  r.get('/contracts/:id/editor', requireRole('legal'), wrap(async (req, res) => {
    if (!config.office.url || !config.office.secret) fail(422, 'OFFICE_NOT_CONFIGURED', '请先配置 OnlyOffice 服务');
    const c = await accessible(db, req.user, z.string().uuid().parse(req.params.id));
    const v = await db('la_versions').where({ id: c.current_version_id }).first();
    if (!v?.filename.toLowerCase().endsWith('.docx')) fail(400, 'DOCX_ONLY', '仅 DOCX 支持在线编辑');
    const key = randomUUID();
    await db('la_editor_sessions').insert({ key, contract_id: c.id, version_id: v.id, user_id: req.user.id, expires_at: new Date(Date.now() + 8 * 3600000) });
    const value = { documentType: 'word', document: { fileType: 'docx', key, title: v.filename, url: `${config.office.backendUrl}/api/files/${v.id}?token=${documentToken(v.id, req.user.id)}`, permissions: { edit: true, review: true, comment: true } }, editorConfig: { mode: 'edit', lang: 'zh-CN', callbackUrl: `${config.office.backendUrl}/api/onlyoffice/callback`, user: { id: req.user.id, name: req.user.display_name }, customization: { forcesave: true } } };
    res.json({ serverUrl: config.office.url, config: { ...value, token: jwt.sign(value, config.office.secret, { algorithm: 'HS256', expiresIn: '8h' }) } });
  })); return r;
}
module.exports = { publicRouter, privateRouter, documentToken };
