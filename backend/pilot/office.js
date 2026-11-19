const express = require('express');
const jwt = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');
const { z } = require('zod');
const { config } = require('./config');
const { wrap, fail } = require('./errors');
const { accessible, requireRole, hasRole, audit } = require('./auth');
const { addVersion } = require('./contracts');
const storage = require('./storage');
const { editorDocument } = require('./office-document');
function documentToken(versionId, userId, context = {}) { return jwt.sign({ versionId, userId, ...(context.key ? { editorKey: context.key, reviewId: context.reviewId || null } : {}) }, config.tokenSecret, { algorithm: 'HS256', audience: 'office-document', expiresIn: '15m' }); }
async function memberReview(db, user, id, version) {
  const run = await db('la_reviews').where({ id, status: 'completed' }).first();
  if (!run) return null;
  await accessible(db, user, run.contract_id);
  if (run.version_id !== version.id && !run.snapshot?.jointGroup?.documents.some(d => d.versionId === version.id && d.contractId === version.contract_id && d.sha256 === version.sha256)) return null;
  await require('./joint-intake').reviewDocument(db, user, run, version.id); return run;
}
function publicRouter(db) {
  const r = express.Router();
  r.get('/onlyoffice/documents/:key', wrap(async (req, res) => {
    let claims;
    try { claims = jwt.verify(req.query.token, config.tokenSecret, { algorithms: ['HS256'], audience: 'office-document' }); } catch { fail(401, 'INVALID_DOCUMENT_TOKEN', '编辑文档凭证无效或已过期'); }
    if (claims.editorKey !== req.params.key) fail(403, 'DOCUMENT_SCOPE', '凭证不适用于此编辑会话');
    const session = await db('la_editor_sessions').where({ key: claims.editorKey, user_id: claims.userId }).first();
    if (!session || new Date(session.expires_at) < new Date() || session.version_id !== claims.versionId) fail(403, 'EDITOR_SESSION_EXPIRED', '编辑会话已失效');
    const user = await db('la_users').where({ id: claims.userId, active: true }).first();
    if (!hasRole(user, 'legal')) fail(403, 'FORBIDDEN', '编辑权限已失效');
    await accessible(db, user, session.contract_id);
    const version = await db('la_versions').where({ id: claims.versionId, contract_id: session.contract_id }).first();
    if (!version) fail(404, 'VERSION_NOT_FOUND', '编辑原文不存在');
    let review, findings = [];
    if (claims.reviewId) {
      review = await memberReview(db, user, claims.reviewId, version);
      if (!review) fail(409, 'EDITOR_REVIEW_CHANGED', '审查记录已变化，请重新打开编辑器');
      findings = await db('la_findings').where({ review_id: review.id }).orderBy('created_at').orderBy('id');
      if (review.snapshot?.jointGroup) findings = require('./joint-review').evidenceForFile(findings, version.id, review.version_id);
    }
    const converted = version.conversion?.artifacts?.docx;
    const source = converted ? { ...version, filename: version.filename.replace(/\.[^.]+$/, '.docx') } : version;
    const buffer = editorDocument(await storage.read(converted?.storage_key || version.storage_key), source, review, findings);
    res.set('Cache-Control', 'private, no-store').type('application/vnd.openxmlformats-officedocument.wordprocessingml.document').send(buffer);
  }));
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
    const variant = req.query.variant;
    if (variant && !['pdf', 'docx', 'text'].includes(variant)) fail(400, 'INVALID_FILE_VARIANT', '文件副本类型无效');
    const artifact = variant ? v.conversion?.artifacts?.[variant] : v;
    if (!artifact) fail(404, 'CONVERSION_NOT_READY', '转换副本尚未生成');
    const filename = variant ? `${v.filename.replace(/\.[^.]+$/, '')}_转换副本.${variant === 'text' ? 'json' : variant}` : v.filename;
    res.set('Cache-Control', 'private, no-store').type(artifact.media_type);
    if (req.query.download || variant === 'text') res.attachment(filename);
    res.send(await storage.read(artifact.storage_key));
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
      if (!s || new Date(s.expires_at) < new Date()) fail(403, 'EDITOR_SESSION_EXPIRED', '编辑会话已失效');
      const user = await trx('la_users').where({ id: s.user_id, active: true }).first(); if (!hasRole(user, 'legal')) fail(403, 'FORBIDDEN', '编辑权限已失效');
      const c = await accessible(trx, user, s.contract_id, true);
      const buffer = Buffer.concat(buffers), sha256 = storage.sha256(buffer);
      if (await trx('la_editor_saves').where({ editor_key: s.key, sha256 }).first()) return;
      if (c.current_version_id !== s.version_id) fail(409, 'EDITOR_STALE', '合同已有新版本，请重新打开编辑器');
      const v = await trx('la_versions').where({ id: s.version_id }).first();
      const result = await addVersion(trx, c, { originalname: v.conversion?.artifacts?.docx ? v.filename.replace(/\.[^.]+$/, '.docx') : v.filename, buffer }, user.id, 'onlyoffice');
      await trx('la_editor_saves').insert({ editor_key: s.key, sha256, version_id: result.version.id });
      await trx('la_editor_sessions').where({ key: s.key }).update({ version_id: result.version.id });
      await audit(trx, user, 'document.office_save', c.id, { versionId: result.version.id, duplicate: result.duplicate });
    }); res.json({ error: 0 });
  }));
  return r;
}
function privateRouter(db) {
  const r = express.Router();
  async function editorSession(req) {
    const c = await accessible(db, req.user, z.string().uuid().parse(req.params.id));
    const session = await db('la_editor_sessions').where({ key: z.string().uuid().parse(req.params.key), contract_id: c.id, user_id: req.user.id }).first();
    if (!session || new Date(session.expires_at) < new Date()) fail(403, 'EDITOR_SESSION_EXPIRED', '编辑会话已失效，请重新打开编辑器');
    return { c, session };
  }
  r.get('/contracts/:id/editor/:key', requireRole('legal'), wrap(async (req, res) => {
    const { c, session } = await editorSession(req);
    const saved = await db('la_editor_saves').where({ editor_key: session.key }).orderBy('created_at', 'desc').first();
    const version = await db('la_versions').where({ id: session.version_id }).first();
    res.json({ versionId: session.version_id, versionNo: version.version_no, current: c.current_version_id === session.version_id, saved: !!saved });
  }));
  r.post('/contracts/:id/editor/:key/save', requireRole('legal'), wrap(async (req, res) => {
    const { c, session } = await editorSession(req);
    if (c.current_version_id !== session.version_id) fail(409, 'EDITOR_STALE', '合同已有其他新版本，请先保存副本并重新打开编辑器');
    const command = { c: 'forcesave', key: session.key };
    const response = await fetch(config.office.internalUrl.replace(/\/$/, '') + '/coauthoring/CommandService.ashx', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...command, token: jwt.sign(command, config.office.secret, { algorithm: 'HS256' }) }), signal: AbortSignal.timeout(20000), redirect: 'error' });
    if (!response.ok) fail(502, 'OFFICE_SAVE_FAILED', '无法请求编辑器保存，请稍后重试');
    const value = await response.json();
    if (![0, 4].includes(value.error)) fail(502, 'OFFICE_SAVE_FAILED', '编辑器尚未完成同步，请稍后重试保存');
    res.json({ queued: value.error === 0, versionId: session.version_id });
  }));
  r.post('/contracts/:id/editor/:key/draft', requireRole('legal'), wrap(async (req, res) => {
    const { c, session } = await editorSession(req);
    res.json(await require('./office-drafts').generateDraft(db, req.user, c, session, req.body));
  }));
  r.post('/contracts/:id/editor/:key/apply-draft', requireRole('legal'), wrap(async (req, res) => {
    const { c, session } = await editorSession(req);
    res.json(await require('./office-drafts').applyDraft(db, req.user, c.id, session.key, req.body.token));
  }));
  r.get('/contracts/:id/editor', requireRole('legal'), wrap(async (req, res) => {
    if (!config.office.url || !config.office.secret) fail(422, 'OFFICE_NOT_CONFIGURED', '请先配置 OnlyOffice 服务');
    const response = await db.transaction(async trx => {
      const c = await accessible(trx, req.user, z.string().uuid().parse(req.params.id), true);
      const expectedVersion = z.string().uuid().optional().parse(req.query.versionId);
      if (expectedVersion && expectedVersion !== c.current_version_id) fail(409, 'EDITOR_VERSION_CHANGED', '合同已有新版本，请刷新并切换到最新版后改稿');
      const v = await trx('la_versions').where({ id: c.current_version_id }).first();
      const convertedWord = v?.conversion?.artifacts?.docx;
      if (!v?.filename.toLowerCase().endsWith('.docx') && !convertedWord) fail(400, 'DOCX_ONLY', '仅 DOCX 或已转换为 DOCX 的 Word 文档支持在线编辑');
      const reviewId = z.string().uuid().optional().parse(req.query.reviewId);
      const review = reviewId ? await memberReview(trx, req.user, reviewId, v) : await trx('la_reviews').where({ id: c.current_review_id, contract_id: c.id, version_id: v.id, status: 'completed' }).first();
      if (reviewId && !review) fail(409, 'EDITOR_REVIEW_VERSION', '该审查意见对应其他版本，请切换到当前版本后编辑');
      const key = randomUUID();
      await trx('la_editor_sessions').insert({ key, contract_id: c.id, version_id: v.id, user_id: req.user.id, expires_at: new Date(Date.now() + 8 * 3600000) });
      const value = { documentType: 'word', document: { fileType: 'docx', key, title: convertedWord ? v.filename.replace(/\.[^.]+$/, '.docx') : v.filename, url: `${config.office.backendUrl}/api/onlyoffice/documents/${key}?token=${documentToken(v.id, req.user.id, { key, reviewId: review?.id })}`, permissions: { edit: true, review: true, comment: true } }, editorConfig: { mode: 'edit', lang: 'zh-CN', callbackUrl: `${config.office.backendUrl}/api/onlyoffice/callback`, user: { id: req.user.id, name: req.user.display_name }, customization: { forcesave: true, comments: true, review: { trackChanges: true, reviewDisplay: 'markup', showReviewChanges: true } } } };
      return { serverUrl: config.office.url, session: { key, versionId: v.id, versionNo: v.version_no, reviewId: review?.id || null }, config: { ...value, token: jwt.sign(value, config.office.secret, { algorithm: 'HS256', expiresIn: '8h' }) } };
    });
    res.json(response);
  })); return r;
}
module.exports = { publicRouter, privateRouter, documentToken };
