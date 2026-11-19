const { randomUUID } = require('node:crypto');
const multer = require('multer');
const { z } = require('zod');
const { wrap, fail, AppError } = require('./errors');
const { requireRole, accessible, audit, hasRole } = require('./auth');
const storage = require('./storage');
const bounded = require('./agent/config').bounded;
const MAX_FILES = bounded(process.env.AUTO_REVIEW_MAX_FILES, 20, 1, 100);
const MAX_TOTAL_BYTES = bounded(process.env.AUTO_REVIEW_MAX_TOTAL_BYTES, 200 * 1024 * 1024, 1, 500 * 1024 * 1024);
const MAX_FILE_BYTES = bounded(process.env.AUTO_REVIEW_MAX_FILE_BYTES, 50 * 1024 * 1024, 1, 50 * 1024 * 1024);
// Enforce the aggregate limit while streaming as well as in the domain API;
// otherwise 20 individually valid 50MB files would buffer a gigabyte first.
const upload = multer({ storage: {
  _handleFile(req, file, callback) {
    const chunks = []; let finished = false, size = 0;
    file.stream.on('data', chunk => {
      if (finished) return;
      req.autoReviewBytes = (req.autoReviewBytes || 0) + chunk.length;
      if (req.autoReviewBytes > MAX_TOTAL_BYTES) { finished = true; chunks.length = 0; callback(new AppError(413, 'AUTO_REVIEW_TOTAL_LIMIT', '上传材料超过批次总大小限制')); return; }
      chunks.push(chunk); size += chunk.length;
    });
    file.stream.once('error', error => { if (!finished) { finished = true; callback(error); } });
    file.stream.once('end', () => { if (!finished) { finished = true; callback(null, { buffer: Buffer.concat(chunks), size }); } });
  },
  _removeFile(_req, file, callback) { delete file.buffer; callback(); },
}, defParamCharset: 'utf8', limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES, fields: 20 } });
const receiveFiles = upload.fields([{ name: 'files', maxCount: MAX_FILES }, { name: 'files[]', maxCount: MAX_FILES }]);
function receive(req, res, next) { receiveFiles(req, res, error => { if (error instanceof multer.MulterError) return res.status(413).json({ code: error.code, message: error.code === 'LIMIT_FILE_SIZE' ? '材料超过单文件大小限制' : `每批最多 ${MAX_FILES} 份材料，请检查文件和表单限制` }); next(error); }); }
const uuid = z.string().uuid();
const activeStatuses = ['queued', 'ingesting', 'planning', 'executing', 'observing', 'drafting'];
const backgroundSchema = z.object({ ourEntity: z.string().trim().max(200).default(''), ourSide: z.enum(['', 'party_a', 'party_b', 'other']).default(''), perspective: z.string().trim().max(200).default(''), purpose: z.string().trim().max(3000).default('') });
const json = value => JSON.stringify(value);
const digest = value => storage.sha256(Buffer.from(json(value)));
function parseJson(value) { try { return typeof value === 'string' ? JSON.parse(value) : value || {}; } catch { fail(400, 'INVALID_JSON', '表单 JSON 字段无效'); } }
async function enqueue(db, id) { await db('la_outbox').insert({ id: randomUUID(), queue: 'auto-review-batch', payload: json({ batchId: id }) }); }
async function addEvent(db, id, type, stage, data = {}) { await db('la_auto_review_batch_events').insert({ batch_id: id, type, stage, data: json(data) }); }
async function transition(db, id, stage, data = {}, patch = {}) {
  const progress = { queued: 0, ingesting: 10, planning: 20, executing: 40, observing: 70, drafting: 85, completed: 100, partial: 100, needs_attention: 100, failed: 100 }[stage];
  const n = await db('la_auto_review_batches').where({ id }).whereNot('status', 'cancelled').update({ ...patch, status: stage, stage, progress: progress || 0, revision: db.raw('revision + 1'), updated_at: db.fn.now() });
  if (!n) fail(409, 'AUTO_REVIEW_STOPPED', '自动评审已停止');
  await addEvent(db, id, stage, stage, data);
}
async function assertCurrent(db, id) {
  const b = await db('la_auto_review_batches').where({ id }).first();
  if (!b || !activeStatuses.includes(b.status)) fail(409, 'AUTO_REVIEW_STOPPED', '自动评审批次已停止或已结束');
  if (b.intake_id) {
    const docs = await require('./joint-intake').documents(db, b.intake_id);
    if (intakeHash(docs) !== b.request_hash) fail(409, 'AUTO_REVIEW_MATERIAL_CHANGED', '审批附件已变化，请使用新的自动评审批次');
  }
  return b;
}
async function readBatch(db, user, id, lock = false) {
  let q = db('la_auto_review_batches').where({ id: uuid.parse(id) });
  if (lock) q = q.forUpdate();
  const b = await q.first();
  if (!b) fail(404, 'AUTO_REVIEW_BATCH_NOT_FOUND', '自动评审批次不存在');
  await accessible(db, user, b.container_id);
  return b;
}
async function publicBatch(db, user, id, detail = true) {
  const b = await readBatch(db, user, id);
  const documents = await db('la_auto_review_batch_documents').where({ batch_id: id }).orderBy('created_at').orderBy('id');
  // Every file is separately authorized, including frozen DingTalk attachments.
  for (const d of documents) if (d.contract_id) await accessible(db, user, d.contract_id);
  const artifacts = await db('la_auto_review_artifacts').where({ batch_id: id }).orderBy('created_at');
  const result = { ...b, executionPlan: b.execution_plan, qualityGate: b.quality_gate, documents, limits: { maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES }, artifactCount: artifacts.filter(a => a.version_id).length };
  if (!detail) return result;
  result.artifacts = artifacts.map(a => ({ ...a, locatedFindingIds: a.located_finding_ids, unlocatedFindingIds: a.unlocated_finding_ids, downloadUrl: a.status === 'ready' ? `/api/auto-review-batches/${id}/artifacts/${a.id}/download` : null }));
  result.events = await db('la_auto_review_batch_events').where({ batch_id: id }).orderBy('id');
  if (b.main_review_id) {
    const run = await db('la_reviews').where({ id: b.main_review_id }).first();
    if (run) {
      const messages = await db('la_agent_messages').where({ review_id: run.id, kind: 'question' }).select('id', 'content', 'data');
      result.review = { id: run.id, sessionId: run.agent_session_id, status: run.status, stage: run.stage, coverage: run.coverage, candidateSaved: !!run.agent_result, agentResult: run.status === 'completed' ? run.agent_result : null, errorCode: run.error_code, errorMessage: run.error_message, questions: messages };
      // Read ranges survive a continuation. Reuse only persisted reading counts
      // from the same session and exact frozen documents, without changing any
      // round's coverage, plan, candidate or publication gates.
      const saved = await db('la_reviews').where({ agent_session_id: run.agent_session_id })
        .whereRaw("snapshot->'documents' = ?::jsonb", [json(run.snapshot.documents)])
        .whereRaw("(coverage->>'totalBlocks')::integer > 0")
        .orderByRaw("(coverage->>'readBlocks')::integer DESC NULLS LAST").orderBy('created_at', 'desc').first('id', 'coverage');
      if (saved) result.review.savedCoverage = { sourceReviewId: saved.id, readBlocks: saved.coverage.readBlocks, totalBlocks: saved.coverage.totalBlocks };
      result.findings = await db('la_findings').where({ review_id: run.id }).orderBy('created_at').orderBy('id');
      const events = await db('la_agent_events').where({ review_id: run.id }).whereIn('type', ['tool', 'skill_loaded', 'skill_resource_read', 'system_skills_injected', 'started', 'model_request', 'model_progress', 'model_response', 'model_failed', 'waiting_input', 'paused', 'failed']).orderBy('id');
      result.activity = events;
      // Older runs predate per-request diagnostics. Reuse only the verified
      // timing evidence for this exact review; never expose the raw audit/log.
      if (run.error_code === 'AGENT_MODEL_TIMEOUT' && !events.some(e => e.type === 'model_failed')) {
        const diagnosis = await db('la_audit').where({ entity_id: id, action: 'auto_review_batch.timeout_diagnosed' }).whereRaw("details->>'reviewId' = ?", [run.id]).orderBy('id', 'desc').first('details');
        if (Array.isArray(diagnosis?.details?.timeouts)) result.review.timeoutDiagnosis = { attempts: diagnosis.details.timeouts
          .filter(a => [a.started, a.ended, a.duration].every(Number.isFinite) && a.started >= 0 && a.duration >= 0 && a.ended >= a.started && a.ended <= 8640000000000000)
          .map(({ started, ended, duration }) => ({ started, ended, duration })) };
      }
      // Resolve labels from the frozen review, so renamed or revoked memories
      // cannot silently change the explanation of a historical run.
      const builtin = require('./auto-review-tools').skill;
      const system = new Map((run.snapshot?.systemSkills || []).map(s => [s.name, s]));
      const memories = new Map((run.snapshot?.memories || []).filter(m => m.kind === 'skill').map(m => ['legal-' + m.id, m]));
      const loaded = new Map();
      for (const event of events.filter(e => e.type === 'skill_loaded')) {
        const name = event.data.name;
        if (!name || loaded.has(name)) continue;
        const method = name === builtin.name ? builtin : system.get(name) || memories.get(name);
        loaded.set(name, { name, title: method?.title || '历史审查方法', description: name === builtin.name ? '核对材料与条款、复核风险依据，生成合同修改建议。' : method?.description || '此方法未保存可展示的名称，可在执行详情中核对原始标识。', source: name === builtin.name || system.has(name) ? 'builtin' : method ? 'experience' : 'unknown', versionId: method?.versionId || method?.id || event.data.versionId || null, loadedAt: event.created_at });
      }
      result.skills = [...loaded.values()];
    }
  }
  if (hasRole(user, 'legal')) {
    const results = require('./agent/memory-results');
    const query = db('la_agent_legal_events as e').join('la_contracts as c', 'c.id', 'e.contract_id')
      .where('e.kind', 'review_revision').whereJsonSupersetOf('e.source', { batchId: b.id });
    if (!hasRole(user, 'admin') && user.department !== '*') query.where('c.department', user.department || '');
    const rows = await query.select('e.*', 'c.title as contract_title').orderBy('e.created_at', 'desc').limit(20);
    result.learningSources = await results.enrichSources(db, rows);
  }
  return result;
}
async function createBatch(db, user, files, { background = {}, sourceKey, title = '' } = {}) {
  if (!files?.length) fail(400, 'FILE_REQUIRED', '至少上传一份材料');
  if (files.length > MAX_FILES) fail(413, 'AUTO_REVIEW_FILE_LIMIT', `每批最多 ${MAX_FILES} 份材料`);
  if (files.some(f => f.buffer.length > MAX_FILE_BYTES)) fail(413, 'AUTO_REVIEW_FILE_SIZE', '材料超过单文件大小限制');
  if (files.reduce((n, f) => n + f.buffer.length, 0) > MAX_TOTAL_BYTES) fail(413, 'AUTO_REVIEW_TOTAL_LIMIT', `每批最多 ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)}MB`);
  files.forEach(f => storage.validateUpload(f));
  background = backgroundSchema.parse(background);
  if (!background.ourEntity && ['party_a', 'party_b'].includes(background.ourSide)) background.ourEntity = background.ourSide === 'party_a' ? '合同所列甲方' : '合同所列乙方';
  title = z.string().trim().max(300).parse(title);
  const requestHash = digest({ title, background, files: files.map(f => [storage.safeName(f.originalname), storage.sha256(f.buffer)]).sort() });
  const key = z.string().min(1).max(200).parse(sourceKey || requestHash);
  const id = await db.transaction(async trx => {
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['auto-create:' + user.id + key]);
    const old = await trx('la_auto_review_batches').where({ owner_id: user.id, source_key: key }).first();
    if (old) { if (old.request_hash !== requestHash) fail(409, 'IDEMPOTENCY_CONFLICT', '相同请求标识不能提交不同材料或背景'); return old.id; }
    const batchId = randomUUID(), containerId = randomUUID();
    await trx('la_contracts').insert({ id: containerId, number: 'AR-' + batchId, title: title || files[0].originalname, submitter_id: user.id, reviewer_id: user.id, department: user.department || '', source_data: json({ autoReviewBatchId: batchId, jointHidden: true }), background: json(background) });
    await trx('la_auto_review_batches').insert({ id: batchId, owner_id: user.id, container_id: containerId, source: 'manual', source_key: key, request_hash: requestHash, background: json(background), result: json({ title: title || files[0].originalname }) });
    const hashes = new Set();
    for (const f of files) {
      const hash = storage.sha256(f.buffer);
      if (hashes.has(hash)) continue;
      hashes.add(hash);
      const saved = await require('./contracts').createContract(trx, user, f, { background, reviewerId: user.id, sourceData: { autoReviewBatchId: batchId } });
      await trx('la_auto_review_batch_documents').insert({ id: randomUUID(), batch_id: batchId, contract_id: saved.contract.id, version_id: saved.version.id, filename: saved.version.filename, sha256: saved.version.sha256 });
    }
    await enqueue(trx, batchId);
    await addEvent(trx, batchId, 'queued', 'queued', { message: '材料已接收，原件已保存', submittedFiles: files.length, uniqueFiles: hashes.size });
    await audit(trx, user, 'auto_review_batch.created', batchId, { files: hashes.size });
    return batchId;
  });
  return publicBatch(db, user, id);
}
function intakeHash(docs) { return digest(docs.filter(d => d.present).map(d => [d.id, d.version?.id || null, d.version?.sha256 || null, d.status, d.filename]).sort((a, b) => a[0].localeCompare(b[0]))); }
async function ensureBatchFromIntake(db, intakeId) {
  return db.transaction(async trx => {
    await require('./joint-intake').lockIntake(trx, intakeId);
    const intake = await trx('la_dingtalk_intakes').where({ id: intakeId }).first();
    if (!intake) return null;
    const docs = (await require('./joint-intake').documents(trx, intakeId)).filter(d => d.present);
    if (!docs.length) return null;
    const hash = intakeHash(docs), key = 'dingtalk:' + intakeId + ':' + hash;
    const old = await trx('la_auto_review_batches').where({ owner_id: intake.recipient_id, source_key: key }).first();
    if (old) return old.id;
    const container = await trx('la_contracts').where({ id: intake.container_id }).first();
    const id = randomUUID();
    await trx('la_auto_review_batches').insert({ id, owner_id: intake.recipient_id, container_id: intake.container_id, intake_id: intakeId, source: 'dingtalk', source_key: key, request_hash: hash, background: json(container.background || {}), result: json({ title: container.title }) });
    for (const d of docs) await trx('la_auto_review_batch_documents').insert({ id: randomUUID(), batch_id: id, intake_document_id: d.id, contract_id: d.contract_id, version_id: d.version?.id || null, filename: d.filename, sha256: d.version?.sha256 || null, ingest_status: d.version && d.status === 'collected' ? 'ready' : 'failed', error_message: d.error });
    const overLimit = docs.length > MAX_FILES || docs.some(d => Number(d.version?.size || 0) > MAX_FILE_BYTES) || docs.reduce((n,d) => n + Number(d.version?.size || 0), 0) > MAX_TOTAL_BYTES;
    if (overLimit) await transition(trx, id, 'needs_attention', { message: '审批附件包超过批次限制，请拆分材料后重新提交' }, { error_message: '审批附件包超过文件数量或大小限制，尚未开始审查' });
    else await enqueue(trx, id);
    await addEvent(trx, id, 'queued', 'queued', { message: '本次审批全部附件进入自动评审，无需人工确认分组' });
    return id;
  });
}
async function processBatch(db, id, options = {}) {
  const connection = await db.client.acquireConnection();
  let locked = false, backupLocked = false;
  try {
    locked = (await db.raw('SELECT pg_try_advisory_lock(hashtext(?)) AS locked', ['auto-batch:' + id]).connection(connection)).rows[0].locked;
    if (!locked) return;
    await db.raw('SELECT pg_advisory_lock_shared(hashtext(?))', ['legal-data-backup']).connection(connection); backupLocked = true;
    let batch = await db('la_auto_review_batches').where({ id }).first();
    if (!batch || !activeStatuses.includes(batch.status)) return;
    await assertCurrent(db, id);
    const actor = await db('la_users').where({ id: batch.owner_id, active: true }).first();
    if (!actor || !hasRole(actor, 'business', 'legal')) fail(403, 'AGENT_ACCESS_REVOKED', '发起人的访问权限已失效');
    await accessible(db, actor, batch.container_id);
    let run = batch.main_review_id && await db('la_reviews').where({ id: batch.main_review_id }).first();
    if (!run) {
      await transition(db, id, 'ingesting', { message: '校验并解析全部材料' });
      const docs = await db('la_auto_review_batch_documents').where({ batch_id: id }).orderBy('created_at').orderBy('id');
      const entries = [], unavailable = [];
      for (const d of docs) {
        await assertCurrent(db, id);
        try {
          const intakeDoc = d.intake_document_id && await db('la_intake_documents').where({ id: d.intake_document_id }).first();
          if (!d.version_id || intakeDoc && intakeDoc.status !== 'collected') fail(422, 'AUTO_FILE_UNAVAILABLE', d.error_message || '附件未收取或格式不支持');
          await accessible(db, actor, d.contract_id);
          const entry = { versionId: d.version_id, contractId: d.contract_id, sha256: d.sha256, filename: d.filename, role: 'uncertain' };
          await require('./joint-intake').readDocument(db, entry, options);
          entries.push(entry);
          await db('la_auto_review_batch_documents').where({ id: d.id }).update({ ingest_status: 'ready', error_message: null });
        } catch (e) {
          if (['FILE_INTEGRITY', 'AGENT_ACCESS_REVOKED'].includes(e.code) || [403, 404].includes(e.status)) throw e;
          const message = e.code ? e.message : '文件解析失败';
          unavailable.push({ filename: d.filename, versionId: d.version_id, reason: message });
          await db('la_auto_review_batch_documents').where({ id: d.id }).update({ ingest_status: 'failed', error_message: message });
        }
      }
      if (!entries.length) fail(422, 'AUTO_REVIEW_NO_READABLE_DOCUMENTS', '所有文件均无法读取，请补传可读文件');
      await db.transaction(async trx => {
        await assertCurrent(trx, id);
        const c = await accessible(trx, actor, entries[0].contractId, true);
        const created = await require('./agent/service').createSession(trx, c, actor.id, { content: '自动评审：先加载 legal-auto-review 技能，读取材料并使用 create_review_plan 生成计划，然后自主执行、submit_review、observe_review。缺失事实列为待核实，禁止编造。', batch: { id, documents: entries, unavailable }, clientKey: 'batch:' + id });
        await transition(trx, id, 'planning', { message: '等待 Agent 加载技能并提交执行计划' }, { main_contract_id: c.id, main_review_id: created.reviewId });
      });
      batch = await db('la_auto_review_batches').where({ id }).first();
      run = await db('la_reviews').where({ id: batch.main_review_id }).first();
    }
    if (run.status !== 'completed') {
      // A continuation already has a review, so it skips ingestion/session
      // creation. Leave the queue as soon as this worker takes it up too.
      batch = await assertCurrent(db, id);
      const stage = run.agent_result ? 'observing' : batch.execution_plan?.reviewId === run.id ? 'executing' : 'planning';
      if (batch.status !== stage) await transition(db, id, stage, { message: '后台已开始执行本轮审查' });
      await require('./agent/service').processReview(db, run.id, { ...options, batchBackupLocked: true });
      run = await db('la_reviews').where({ id: run.id }).first();
    }
    await assertCurrent(db, id);
    if (run.status !== 'completed') {
      const stage = run.status === 'failed' ? 'failed' : 'needs_attention';
      const message = run.error_message || (run.stage === 'awaiting_answer' ? '审查需要确认信息，请在下方回答具体问题后继续。' : run.agent_result ? '候选报告已保存，结果复核尚未完成。可继续复核并生成批注建议稿。' : '报告尚未提交，执行已暂停。已读取的材料和审查记录已保存，可直接继续。');
      await transition(db, id, stage, { message, code: run.error_code }, { error_message: message });
      return;
    }
    batch = await db('la_auto_review_batches').where({ id }).first();
    if (!run.coverage.complete || !run.agent_result || batch.quality_gate.observedReviewId !== run.id) fail(422, 'AUTO_REVIEW_QUALITY_GATE', '报告必须通过全文覆盖、证据校验和 Agent 观察');
    await transition(db, id, 'drafting', { message: '正在按文件生成 Word 批注建议稿，正文保持不变' });
    const artifacts = await require('./auto-review-artifacts').generate(db, batch, run, (trx = db) => assertCurrent(trx, id), options);
    const docs = await db('la_auto_review_batch_documents').where({ batch_id: id });
    const partial = docs.some(d => d.ingest_status === 'failed') || artifacts.some(a => a.status !== 'ready' || a.unlocated_finding_ids.length);
    const findingCount = Number((await db('la_findings').where({ review_id: run.id, check_status: 'fail' }).count('* as n').first()).n);
    await transition(db, id, partial ? 'partial' : 'completed', { message: partial ? '报告和可生成的改稿已保存，仍有待核实事项' : '自动审查、观察和改稿已完成' }, { error_message: null, result: json({ ...batch.result, findingCount, artifactCount: artifacts.filter(a => a.version_id).length }) });
  } catch (e) {
    const b = await db('la_auto_review_batches').where({ id }).first();
    if (b && b.status !== 'cancelled') await transition(db, id, e.code === 'AUTO_REVIEW_QUALITY_GATE' ? 'needs_attention' : 'failed', { message: e.code ? e.message : '自动评审中断，工作已保存', code: e.code || 'AUTO_REVIEW_FAILED' }, { error_message: e.code ? e.message : '自动评审中断，工作已保存' });
  } finally {
    if (backupLocked) await db.raw('SELECT pg_advisory_unlock_shared(hashtext(?))', ['legal-data-backup']).connection(connection);
    if (locked) await db.raw('SELECT pg_advisory_unlock(hashtext(?))', ['auto-batch:' + id]).connection(connection);
    await db.client.releaseConnection(connection);
  }
}
async function control(db, user, id, action, input = {}) {
  return db.transaction(async trx => {
    const batch = await readBatch(trx, user, id, true);
    if (action === 'cancel') {
      if (!activeStatuses.includes(batch.status)) fail(409, 'AUTO_REVIEW_STATE', '该批次当前没有运行中的任务');
      if (batch.main_review_id) {
        const run = await trx('la_reviews').where({ id: batch.main_review_id }).first();
        if (run && ['running', 'queued'].includes(run.status)) {
          await trx('la_reviews').where({ id: run.id }).update({ status: 'cancelled', stage: 'cancelled' });
          await trx('la_agent_sessions').where({ id: run.agent_session_id }).update({ status: 'cancelled' });
        }
      }
      await trx('la_auto_review_batches').where({ id }).update({ status: 'cancelled', stage: 'cancelled', updated_at: trx.fn.now(), revision: trx.raw('revision + 1') });
      await addEvent(trx, id, 'cancelled', 'cancelled', { message: '停止实际审查任务，保留已保存的工作和产物' });
    } else {
      if (activeStatuses.includes(batch.status) || batch.status === 'completed') fail(409, 'AUTO_REVIEW_STATE', '只能恢复已中断或部分完成的批次');
      const lock = await trx.raw('SELECT pg_try_advisory_xact_lock(hashtext(?)) AS locked', ['auto-batch:' + id]);
      if (!lock.rows[0].locked) fail(409, 'AUTO_REVIEW_STOPPING', '任务正在结束当前操作，请稍后恢复');
      if (batch.intake_id) {
        const docs = await trx('la_auto_review_batch_documents as d').leftJoin('la_versions as v','v.id','d.version_id').where('d.batch_id',id).select('v.size');
        if (docs.length > MAX_FILES || docs.some(d=>Number(d.size||0)>MAX_FILE_BYTES) || docs.reduce((n,d)=>n+Number(d.size||0),0)>MAX_TOTAL_BYTES) fail(413, 'AUTO_REVIEW_BATCH_LIMIT', '审批附件包超过批次限制，请拆分材料后重新提交');
      }
      if (input.background) {
        const background = backgroundSchema.parse(input.background);
        await trx('la_auto_review_batches').where({ id }).update({ background: json(background) });
        if (batch.main_contract_id) await trx('la_contracts').where({ id: batch.main_contract_id }).update({ background: json(background) });
      }
      if (batch.main_review_id) {
        const run = await trx('la_reviews').where({ id: batch.main_review_id }).first();
        const failed = await trx('la_auto_review_batch_documents').where({ batch_id: id, ingest_status: 'failed' }).whereNotNull('version_id');
        if (failed.length) {
          // Reparse frozen originals into a fresh manifest; retain prior reports.
          await trx('la_auto_review_batches').where({ id }).update({ main_review_id: null, execution_plan: '{}', quality_gate: '{}' });
        } else if (run.status !== 'completed' || input.background) {
          const s = await require('./agent/service').sessionFor(trx, user, run.agent_session_id, true);
          const question = await trx('la_agent_messages').where({ review_id: run.id, kind: 'question' }).first();
          let answer = '', answerData = {};
          if (question) {
            if (input.questionId !== question.id) fail(409, 'AGENT_QUESTION_STALE', '请回答当前页面列出的待确认问题');
            const { answerItems, validateAnswers, answerText } = require('./agent/questions');
            const content = z.string().trim().max(20000).parse(input.content || '');
            if (input.answers) {
              if (!question.data?.questions?.length) fail(422, 'AGENT_ANSWER_INVALID', '本问题需要文字回答');
              const answers = validateAnswers(question.data.questions, answerItems.parse(input.answers));
              answer = answerText(question.data.questions, answers, content);
              answerData = { answers, submission: { answers: input.answers, content } };
            } else answer = content;
            if (!answer || answer.length > 20000) fail(422, 'AGENT_ANSWER_INVALID', '请在问题下方填写回答后继续审查');
          } else if (input.questionId || input.answers || input.content) fail(409, 'AGENT_QUESTION_STALE', '当前没有待回答问题，请刷新后继续审查');
          const next = await require('./agent/service').beginRun(trx, s, batch.owner_id, question ? answer : '继续自动评审。补充背景：' + json(input.background || batch.background), { clientKey: randomUUID(), ...(question ? { kind: 'answer', data: { questionId: question.id, ...answerData } } : {}) });
          await trx('la_auto_review_batches').where({ id }).update({ main_review_id: next.reviewId, quality_gate: '{}' });
        }
      }
      await trx('la_auto_review_batches').where({ id }).update({ status: 'queued', stage: 'queued', progress: 0, error_message: null, updated_at: trx.fn.now(), revision: trx.raw('revision + 1') });
      await enqueue(trx, id);
      await addEvent(trx, id, 'queued', 'queued', { message: '已排队恢复，已完成产物按审查版本幂等复用' });
    }
    await audit(trx, user, 'auto_review_batch.' + action, id, {});
  });
}
async function recover(db) {
  for (const b of await db('la_auto_review_batches').whereIn('status', activeStatuses)) {
    const connection = await db.client.acquireConnection();
    try {
      const lock = await db.raw('SELECT pg_try_advisory_lock(hashtext(?)) AS locked', ['auto-batch:' + b.id]).connection(connection);
      if (!lock.rows[0].locked) continue;
      try {
        const current = await db('la_auto_review_batches').where({ id: b.id }).first();
        if (!activeStatuses.includes(current.status)) continue;
        if (current.main_review_id) await db('la_reviews').where({ id: current.main_review_id, status: 'running' }).update({ status: 'queued', stage: 'recovering' });
        await enqueue(db, b.id);
      } finally { await db.raw('SELECT pg_advisory_unlock(hashtext(?))', ['auto-batch:' + b.id]).connection(connection); }
    } finally { await db.client.releaseConnection(connection); }
  }
}
function mountRoutes(r, db) {
  r.get('/auto-review-limits', wrap(async (_req, res) => res.json({ maxFiles: MAX_FILES, maxFileBytes: MAX_FILE_BYTES, maxTotalBytes: MAX_TOTAL_BYTES })));
  r.get('/auto-review-batches', wrap(async (req, res) => {
    const q = db('la_auto_review_batches');
    if (!hasRole(req.user, 'admin')) q.where({ owner_id: req.user.id });
    const rows = await q.orderBy('updated_at', 'desc').limit(100);
    const result = []; for (const b of rows) { try { result.push(await publicBatch(db, req.user, b.id, false)); } catch (e) { if (e.status !== 404) throw e; } }
    res.json(result);
  }));
  r.post('/auto-review-batches', requireRole('business', 'legal'), receive, wrap(async (req, res) => res.status(202).json(await createBatch(db, req.user, [...(req.files?.files || []), ...(req.files?.['files[]'] || [])], { title: req.body.title || '', background: parseJson(req.body.background), sourceKey: req.body.clientKey || req.get('Idempotency-Key') }))));
  r.get('/auto-review-batches/:id', wrap(async (req, res) => res.json(await publicBatch(db, req.user, req.params.id))));
  for (const action of ['cancel', 'resume', 'retry']) r.post('/auto-review-batches/:id/' + action, requireRole('business', 'legal'), wrap(async (req, res) => { await control(db, req.user, req.params.id, action, req.body); res.status(202).json(await publicBatch(db, req.user, req.params.id)); }));
  r.get('/auto-review-batches/:id/artifacts/:artifactId/download', wrap(async (req, res) => {
    const b = await publicBatch(db, req.user, req.params.id);
    const artifact = b.artifacts.find(a => a.id === uuid.parse(req.params.artifactId));
    if (!artifact || artifact.status !== 'ready') fail(404, 'AUTO_REVIEW_ARTIFACT_NOT_FOUND', '产物不存在或生成失败');
    await audit(db, req.user, 'auto_review_batch.download', b.id, { artifactId: artifact.id });
    res.set('Cache-Control', 'private, no-store');
    if (artifact.kind === 'report') {
      const run = await db('la_reviews').where({ id: artifact.review_id }).first(), c = await accessible(db, req.user, run.contract_id), v = await db('la_versions').where({ id: run.version_id }).first();
      res.type('html').attachment(artifact.filename).send(require('./auto-review-artifacts').reportHtml(c, v, run, await db('la_findings').where({ review_id: run.id })));
    } else {
      const v = await db('la_versions').where({ id: artifact.version_id }).first();
      const bytes = await storage.read(v.storage_key);
      if (storage.sha256(bytes) !== v.sha256) fail(409, 'FILE_INTEGRITY', '改稿完整性校验失败');
      res.attachment(storage.safeName(v.filename)).send(bytes);
    }
  }));
}
module.exports = { createBatch, ensureBatchFromIntake, processBatch, recover, mountRoutes, assertCurrent, transition, addEvent, publicBatch, MAX_FILES, MAX_TOTAL_BYTES };
