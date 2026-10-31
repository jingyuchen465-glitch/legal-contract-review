const { hasRole } = require('./auth');
const { randomUUID, createHash } = require('node:crypto');
const { DWClient, EventAck } = require('dingtalk-stream');
const { config } = require('./config');
const { AppError, fail } = require('./errors');
const { createContract, addVersion } = require('./contracts');
const storage = require('./storage');
const { dingConfig, fingerprint, updateSetting } = require('./settings');
async function persistEvent(db, event, eventKey, clientId = null) {
  const dedup = eventKey || createHash('sha256').update(JSON.stringify(event)).digest('hex');
  const key = clientId ? fingerprint([clientId, dedup]) : dedup;
  const eventType = event.EventType || event.eventType || 'approval';
  const queue = eventType === 'reconciliation' ? 'integration-reconcile' : 'integration-live';
  return db.transaction(async trx => {
    const id = randomUUID(); const rows = await trx('la_integration_events').insert({ id, client_id: clientId, dedup_key: key, event_type: eventType, payload: JSON.stringify(event) }).onConflict('dedup_key').ignore().returning('id');
    if (rows.length) await trx('la_outbox').insert({ id: randomUUID(), queue, payload: JSON.stringify({ eventId: id }) });
    return rows[0]?.id || (await trx('la_integration_events').where({ dedup_key: key }).first()).id;
  });
}
function createApprovalApi({ fetchImpl = fetch, connection = config.ding } = {}) {
  let token, expires = 0;
  async function call(path, body, method = 'POST') {
    if (!token || Date.now() > expires) {
      const r = await fetchImpl('https://api.dingtalk.com/v1.0/oauth2/accessToken', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appKey: connection.clientId, appSecret: connection.secret }), signal: AbortSignal.timeout(30000) });
      const v = await r.json(); if (!r.ok || !v.accessToken) fail(422, 'DING_AUTH', '钉钉应用鉴权失败，请核对权限和配置'); token = v.accessToken; expires = Date.now() + (v.expireIn - 120) * 1000;
    }
    const r = await fetchImpl(`https://api.dingtalk.com${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000), redirect: 'error' });
    if (r.status === 401) token = null;
    if (!r.ok) throw new AppError(r.status >= 500 || r.status === 429 ? 503 : 422, 'DING_API', `钉钉接口返回 ${r.status}，请检查审批及附件权限`);
    const data = await r.json(); if (data.success === false) fail(422, 'DING_BUSINESS_ERROR', '钉钉接口未返回成功结果，请核对应用权限和审批配置'); return data.result || data;
  }
  return {
    detail: id => call(`/v1.0/workflow/processInstances?processInstanceId=${encodeURIComponent(id)}`, null, 'GET'),
    async attachment(instanceId, file) {
      if (!file.fileId) fail(422, 'DING_ATTACHMENT_MAPPING', '缺少审批附件标识');
      // Verified against @alicloud/dingtalk 2.2.48 workflow_1_0 GrantProcessInstanceForDownloadFile.
      const result = await call('/v1.0/workflow/processInstances/spaces/files/urls/download', { processInstanceId: instanceId, fileId: String(file.fileId), withCommentAttatchment: false });
      const url = result.downloadUri;
      let parsed; try { parsed = new URL(url); } catch { fail(422, 'DING_ATTACHMENT_URL', '钉钉未返回有效附件下载地址'); }
      const trusted = /(^|\.)(dingtalk\.com|alicdn\.com|aliyuncs\.com|alibaba-inc\.com)$/.test(parsed.hostname);
      if (parsed.protocol === 'http:' && trusted) parsed.protocol = 'https:';
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !trusted) fail(422, 'DING_ATTACHMENT_URL', '附件地址不在钉钉受信下载域名范围');
      const r = await fetchImpl(parsed.href, { redirect: 'error', signal: AbortSignal.timeout(60000) });
      if (!r.ok) fail(422, 'DING_ATTACHMENT_ACCESS', '无法读取审批附件，请检查附件访问权限');
      const parts = []; let size = 0; for await (const part of r.body) { size += part.length; if (size > 50 * 1024 * 1024) fail(413, 'FILE_TOO_LARGE', '审批附件超过50MB'); parts.push(Buffer.from(part)); }
      return Buffer.concat(parts);
    },
  };
}
// Discover structured form attachments, including those inside detail tables.
function attachmentsOf(detail) {
  const files = [], seen = new Set();
  function walk(value, field, depth = 0) {
    if (depth > 20 || value == null) return;
    if (typeof value === 'string') { try { walk(JSON.parse(value), field, depth + 1); } catch {} return; }
    if (Array.isArray(value)) { value.forEach((v, i) => walk(v, field + (Array.isArray(v) ? ':' + i : ''), depth + 1)); return; }
    if (typeof value !== 'object') return;
    if (value.fileId && (value.fileName || value.name)) {
      const key = String(value.fileId);
      if (!seen.has(key)) { files.push({ fileId: key, fileName: String(value.fileName || value.name), field }); seen.add(key); }
      return;
    }
    if ('value' in value) { walk(value.value, field + ':' + (value.id || value.name || 'field'), depth + 1); return; }
    for (const [key, nested] of Object.entries(value)) walk(nested, field + ':' + key, depth + 1);
  }
  for (const field of detail.formComponentValues || []) walk(field.value, field.id || field.name || 'attachment');
  return files;
}
function currentAssignees(detail) {
  if (detail.status && !['RUNNING', 'NEW', 'PENDING'].includes(String(detail.status).toUpperCase())) return [];
  return [...new Set((detail.tasks || []).filter(t => !t.finishTime && (!t.result || t.result === 'NONE') && ['NEW', 'RUNNING', 'PENDING'].includes(String(t.status).toUpperCase()) && t.userId).map(t => String(t.userId)))];
}
async function processIntegration(db, eventId, api) {
  const event = await db('la_integration_events').where({ id: eventId }).first();
  if (!event || ['completed', 'ignored'].includes(event.status)) return;
  const summary = { collected: 0, duplicate: 0, skipped: 0, failed: 0 };
  const save = (status, error = null) => db('la_integration_events').where({ id: eventId }).update({ status, error, summary: JSON.stringify(summary), updated_at: db.fn.now() });
  try {
    const connection = await dingConfig(db);
    if (!connection.enabled || !event.client_id || event.client_id !== connection.clientId) { summary.reason = '接入未启用或事件所属应用已变更'; await save('ignored'); return; }
    const signature = fingerprint(connection);
    api ||= createApprovalApi({ connection });
    const id = event.payload.processInstanceId || event.payload.ProcessInstanceId;
    if (!id) { summary.reason = '非审批实例事件'; await save('ignored'); return; }
    const detail = await api.detail(id), assignees = currentAssignees(detail);
    const accounts = assignees.length ? await db('la_dingtalk_accounts').where({ client_id: connection.clientId }).whereIn('ding_user_id', assignees).whereIn('user_id', db('la_users').select('id').where({active:true})) : [];
    if (!accounts.length) { summary.reason = '当前办理人尚未绑定工作台账号，或审批已离开该办理人'; await save('ignored'); return; }
    const allFiles = attachmentsOf(detail), files = allFiles.filter(f => /\.(pdf|docx)$/i.test(f.fileName));
    summary.skipped = allFiles.length - files.length;
    if (!files.length) { summary.reason = '审批表中没有 PDF 或 DOCX 附件'; await save('completed'); return; }
    // Same field/name identifies a revision. Ambiguous equal names stay separate by file ID.
    const counts = new Map(); for (const f of files) { const key = JSON.stringify([f.field, f.fileName]); counts.set(key, (counts.get(key) || 0) + 1); }
    for (const account of accounts) {
      for (const file of files) {
        try {
          const buffer = await api.attachment(id, file), upload = { buffer, originalname: file.fileName }; storage.validateUpload(upload);
          const sourceKey = 'account:' + fingerprint([connection.clientId, account.user_id, id, file.field, file.fileName, counts.get(JSON.stringify([file.field, file.fileName])) > 1 ? file.fileId : '']);
          const duplicate = await db.transaction(async trx => {
            // Serialize against settings changes, unbinding and account changes before committing downloaded data.
            await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['settings:dingtalk_connection']);
            if (fingerprint(await dingConfig(trx)) !== signature) fail(409, 'DING_CHANGED', '钉钉连接已变更，请重新接入');
            const binding = await trx('la_dingtalk_accounts').where({ user_id: account.user_id, client_id: connection.clientId, ding_user_id: account.ding_user_id }).forShare().first();
            const actor = await trx('la_users').where({ id: account.user_id, active: true }).forShare().first();
            if (!binding || !hasRole(actor, 'business', 'legal')) fail(403, 'DING_UNBOUND', '接收账号已解绑、停用或失去接收权限');
            await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [sourceKey]);
            const existing = await trx('la_source_files').where({ source_key: sourceKey }).first();
            const intakeMode = event.event_type === 'reconciliation' || event.payload?.eventType === 'reconciliation' ? 'reconciliation' : 'live';
            let result;
            if (existing) {
              const c = await trx('la_contracts').where({ id: existing.contract_id }).forUpdate().first();
              const last = await trx('la_versions').where({ id: existing.version_id }).first();
              result = last.sha256 === storage.sha256(buffer) ? { version: last, duplicate: true } : await addVersion(trx, c, upload, actor.id, 'dingtalk');
              await trx('la_source_files').where({ source_key: sourceKey }).update({ version_id: result.version.id, updated_at: trx.fn.now() });
              // A later real-time event is evidence that a legacy row is still
              // an active intake. Let it re-enter the legal queue without
              // changing historical reconciliation records on their own.
              if (intakeMode === 'live' && c.intake_mode === 'reconciliation' && c.intake_review_status === 'pending') {
                await trx('la_contracts').where({ id: c.id }).update({ intake_mode: 'live', intake_review_status: 'confirmed', updated_at: trx.fn.now(), revision: trx.raw('revision + 1') });
              }
            } else {
              result = await createContract(trx, actor, upload, {
                title: file.fileName,
                source: 'dingtalk',
                intakeMode,
                intakeReviewStatus: intakeMode === 'reconciliation' ? 'pending' : 'confirmed',
                reviewerId: hasRole(actor, 'legal') ? actor.id : null,
                sourceData: {
                  processInstanceId: id,
                  fileId: file.fileId,
                  field: file.field,
                  title: detail.title,
                  collectedFor: account.ding_user_id,
                  intakeEventType: event.event_type,
                  reconciliationReason: intakeMode === 'reconciliation' ? '接入后历史审批补查' : null,
                },
              });
              await trx('la_source_files').insert({ source_key: sourceKey, contract_id: result.contract.id, version_id: result.version.id, role: 'main' });
              await trx('la_attachments').insert({ source_key: sourceKey, contract_id: result.contract.id });
            }
            return !!result.duplicate;
          });
          summary[duplicate ? 'duplicate' : 'collected']++;
        } catch (e) { summary.failed++; summary.lastError = e.code ? e.code + ': ' + e.message : '附件读取失败，请检查权限或稍后重试'; }
      }
    }
    await save(summary.failed ? 'waiting_confirmation' : 'completed', summary.lastError || null);
  } catch (e) { summary.failed++; await save('waiting_confirmation', e.code ? e.code + ': ' + e.message : '接入失败，请核对权限或稍后重试'); }
}
async function reconcileKnownApprovals(db, connection, { now = new Date(), maxPending = 100, maxCandidates = 50, windowMs = 15 * 60 * 1000 } = {}) {
  const binding = await db('la_dingtalk_accounts').where({ client_id: connection.clientId }).min('created_at as bound_at').first();
  const cutoff = new Date(now.getTime() - windowMs);
  const boundAt = binding?.bound_at ? new Date(binding.bound_at) : null;
  const lowerBound = boundAt && boundAt > cutoff ? boundAt : cutoff;
  const pending = await db('la_integration_events')
    .where({ client_id: connection.clientId })
    .whereIn('status', ['received', 'waiting_confirmation'])
    .where('created_at', '>', lowerBound)
    .count('* as n')
    .first();
  if (Number(pending.n) >= maxPending) return { skipped: 'backlog', pending: Number(pending.n), enqueued: 0 };

  const rows = await db('la_integration_events')
    .select('payload')
    .where({ client_id: connection.clientId })
    .whereNot({ event_type: 'reconciliation' })
    .whereIn('status', ['received', 'waiting_confirmation'])
    .where('created_at', '>', lowerBound)
    .orderBy('created_at', 'desc')
    .limit(maxCandidates * 2);
  const instanceIds = [...new Set(rows.map(row => row.payload?.processInstanceId || row.payload?.ProcessInstanceId).filter(Boolean))].slice(0, maxCandidates);
  const bucket = Math.floor(now.getTime() / 300000);
  for (const instanceId of instanceIds) await persistEvent(db, { processInstanceId: instanceId, eventType: 'reconciliation' }, `reconcile:${instanceId}:${bucket}`, connection.clientId);
  return { skipped: null, pending: Number(pending.n), enqueued: instanceIds.length };
}
async function startIntegration(db, connection) {
  connection ||= await dingConfig(db);
  if (!connection.enabled) return { stop: async () => {} };
  if (!connection.clientId || !connection.secret) throw new Error('钉钉已启用但缺少应用凭据');
  class DurableClient extends DWClient {
    onEvent(message) {
      (async () => { let event; try { event = JSON.parse(message.data); } catch { this.send(message.headers.messageId, { status: EventAck.LATER }); return; }
        await persistEvent(db, event, message.headers.eventId || message.headers.messageId, connection.clientId);
        this.send(message.headers.messageId, { status: EventAck.SUCCESS });
      })().catch(() => this.send(message.headers.messageId, { status: EventAck.LATER }));
    }
  }
  const client = new DurableClient({ clientId: connection.clientId, clientSecret: connection.secret, keepAlive: true, debug: false });
  client.registerAllEventListener(() => ({ status: EventAck.LATER }));
  try { await client.connect(); } catch (error) { client.disconnect(); throw error; }
  const api = createApprovalApi({ connection }); let reconciling = false;
  async function reconcile() {
    if (reconciling) return; reconciling = true;
    try {
      // Recheck a small recent set only while the integration queue is healthy.
      await reconcileKnownApprovals(db, connection);
    } catch { console.error('dingtalk_reconciliation_failed'); } finally { reconciling = false; }
  }
  const timer = setInterval(reconcile, 300000); void reconcile();
  return { stop: async () => { clearInterval(timer); client.disconnect(); }, reconcile };
}
// Configuration changes are applied by the Worker without restarting the API.
function manageIntegration(db, { start = startIntegration, intervalMs = 15000 } = {}) {
  let active, applied, busy = false, stopped = false;
  async function refresh() {
    if (busy || stopped) return; busy = true;
    try {
      const connection = await dingConfig(db), signature = fingerprint(connection);
      if (signature === applied) return;
      await active?.stop(); active = null;
      try {
        active = await start(db, connection);
        if (stopped) { await active?.stop(); active = null; return; }
        applied = signature;
        await updateSetting(db, 'dingtalk_status', undefined, () => ({ status: connection.enabled ? 'connected' : 'disabled', appliedAt: new Date().toISOString() }));
      } catch {
        await updateSetting(db, 'dingtalk_status', undefined, () => ({ status: 'error', appliedAt: new Date().toISOString(), message: 'Stream 连接失败，请检查应用凭据、网络和事件订阅配置' }));
      }
    } catch { console.error('dingtalk_configuration_refresh_failed'); } finally { busy = false; }
  }
  const timer = setInterval(() => void refresh(), intervalMs); const ready = refresh();
  return { ready, refresh, stop: async () => { stopped = true; clearInterval(timer); while (busy) await new Promise(r => setTimeout(r, 20)); await active?.stop(); } };
}
module.exports = { persistEvent, createApprovalApi, attachmentsOf, currentAssignees, processIntegration, reconcileKnownApprovals, startIntegration, manageIntegration };
