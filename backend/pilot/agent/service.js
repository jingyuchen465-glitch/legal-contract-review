const { randomUUID } = require('node:crypto');
const { ENGINE, UPSTREAM_COMMIT, settings, publicSettings } = require('./config');
const { providerConfig, publicModelSnapshot, assertModelSnapshot } = require('../model');
const { accessible, audit, hasRole } = require('../auth');
const { fail } = require('../errors');
const { localLawCatalog } = require('./official-sources');
const { coverage } = require('./schemas');
const { isDeepStrictEqual } = require('node:util');
const systemSkills = require('./system-skills');
async function event(db, sessionId, reviewId, type, data = {}) {
  return (await db('la_agent_events').insert({ session_id: sessionId, review_id: reviewId, type, data: JSON.stringify(data) }).returning('*'))[0];
}
async function sessionFor(db, user, id, lock = false) {
  let q = db('la_agent_sessions').where({ id }); if (lock) q = q.forUpdate();
  const s = await q.first(); if (!s) fail(404, 'AGENT_SESSION_NOT_FOUND', '审查会话不存在');
  await accessible(db, user, s.contract_id);
  for (const id of s.manifest.revisionBaseline?.accessContractIds || []) await accessible(db, user, id);
  return s;
}
async function usableMemories(db, contract) {
  const q = db('la_agent_memories as m').leftJoin('la_agent_legal_events as e', 'e.id', 'm.source_id')
    .where({ 'm.state': 'active', 'm.department': contract.department || '' }).whereNull('e.revoked_at')
    .where('m.version', '>', 0).orderBy('m.id').select('m.*');
  if (db.isTransaction) q.forShare('m');
  return q;
}
async function beginRun(db, session, actorId, content, { clientKey, kind = 'message', data = {} } = {}) {
  if (clientKey) {
    const old = await db('la_agent_messages').where({ session_id: session.id, client_key: clientKey }).first();
    if (old) { if (old.content !== content) fail(409, 'IDEMPOTENCY_CONFLICT', '同一个请求标识不能用于不同内容'); return { reviewId: old.review_id, sessionId: session.id, duplicate: true }; }
  }
  const prior = session.current_review_id && await db('la_reviews').where({ id: session.current_review_id }).first();
  if (prior && ['queued', 'running'].includes(prior.status)) fail(409, 'AGENT_BUSY', '本会话正在审查，请停止或等待后继续');
  const contract = await db('la_contracts').where({ id: session.contract_id }).first();
  if (contract.current_version_id !== session.version_id) fail(409, 'AGENT_VERSION_CHANGED', '文件已有新版本，请在新版本创建审查');
  if (!session.manifest.autoReviewBatchId) await require('../joint-intake').assertCurrent(db, contract, { jointGroup: session.manifest.jointGroup });
  const model = await providerConfig(db), options = await settings(db), memories = await usableMemories(db, contract);
  const requiredSkills = [...await systemSkills.snapshot(), ...systemSkills.promoted(memories)];
  const previousRuntime = prior?.snapshot;
  if (previousRuntime && (!isDeepStrictEqual([previousRuntime.model, previousRuntime.agentOptions, (previousRuntime.memories || []).map(m => [m.id, m.version]), (previousRuntime.systemSkills || []).map(s => s.versionId)], [model.baseUrl && model.name ? publicModelSnapshot(model) : null, publicSettings(options), memories.map(m => [m.id, m.version]), requiredSkills.map(s => s.versionId)]) || prior.coverage?.requiresRecheck)) {
    // A restored process must not silently retain a different provider or skill catalogue.
    await db('la_agent_sessions').where({ id: session.id }).update({ harness_id: null, notes: '{}' });
    session.harness_id = null;
  }
  const id = randomUUID();
  const batchBackground = session.manifest.autoReviewBatchId && (await db('la_auto_review_batches').where({ id: session.manifest.autoReviewBatchId }).first())?.background;
  const snapshot = {
    engine: ENGINE, upstreamCommit: UPSTREAM_COMMIT, sessionId: session.id,
    versionId: session.version_id, background: batchBackground || contract.background || {},
    ...(session.manifest.autoReviewBatchId ? { autoReviewBatchId: session.manifest.autoReviewBatchId, unavailableDocuments: session.manifest.unavailableDocuments || [] } : {}),
    documents: session.manifest.documents, ...(session.manifest.jointGroup ? { jointGroup: session.manifest.jointGroup } : {}),
    ...(session.manifest.revisionBaseline ? { revisionBaseline: session.manifest.revisionBaseline } : {}),
    model: model.baseUrl && model.name ? publicModelSnapshot(model) : null, agentOptions: publicSettings(options),
    memories, memoryIds: memories.map(m => m.id), systemSkills: requiredSkills, rules: [], packs: [], skills: [], knowledge: [],
    reviewMode: 'formal', promptVersion: 'legal-harness-1.2',
  };
  await db('la_reviews').insert({ id, contract_id: contract.id, version_id: session.version_id, created_by: actorId, engine: ENGINE, agent_session_id: session.id, snapshot: JSON.stringify(snapshot) });
  await db('la_agent_messages').insert({ id: randomUUID(), session_id: session.id, review_id: id, created_by: actorId, role: 'user', kind, content, client_key: clientKey || null, data: JSON.stringify(data) });
  await db('la_agent_sessions').where({ id: session.id }).update({ current_review_id: id, status: 'queued', updated_at: db.fn.now() });
  await db('la_contracts').where({ id: contract.id }).update({ current_review_id: id, current_preanalysis_id: null, review_flow: 'agent', legal_status: 'pending_review', revision: db.raw('revision + 1'), updated_at: db.fn.now() });
  if (!session.manifest.autoReviewBatchId) await db('la_outbox').insert({ id: randomUUID(), queue: 'agent-review', payload: JSON.stringify({ reviewId: id }) });
  await event(db, session.id, id, 'queued', { message: kind === 'answer' ? '已收到补充信息，等待继续审查' : '已建立审查任务' });
  await audit(db, { id: actorId }, 'agent.run.create', id, { sessionId: session.id, versionId: session.version_id });
  return { sessionId: session.id, reviewId: id, duplicate: false };
}
async function createSession(db, contract, actorId, { content = '请审查本次合同与全部关联材料，围绕我方立场和交易目的提出有证据的意见。', clientKey, batch } = {}) {
  // Caller holds the contract row lock. No legacy rule/skill providers are consulted.
  const documents = [], jointGroup = batch ? null : await require('../joint-intake').manifest(db, contract);
  const entries = batch?.documents || jointGroup?.documents || [{ contractId: contract.id, versionId: contract.current_version_id, role: 'main' }];
  for (const e of entries) {
    const v = await db('la_versions').where({ id: e.versionId, contract_id: e.contractId }).first();
    if (!v) fail(409, 'AGENT_DOCUMENT_MISSING', '待审查文件版本不存在');
    documents.push({ ...e, versionId: v.id, contractId: v.contract_id, filename: v.filename, sha256: v.sha256, role: e.role || 'reference' });
  }
  if (!jointGroup && !batch) {
    let supplements = await db('la_versions').where({ contract_id: contract.id, kind: 'supplement' }).orderBy('version_no');
    if (Array.isArray(contract.background?.supplementIds)) {
      if (contract.background.supplementIds.some(id => !supplements.some(v => v.id === id))) fail(400, 'INVALID_SUPPLEMENT', '关联材料不属于本合同');
      supplements = supplements.filter(v => contract.background.supplementIds.includes(v.id));
    }
    for (const v of supplements) documents.push({ versionId: v.id, contractId: v.contract_id, filename: v.filename, sha256: v.sha256, role: 'reference' });
  }
  const revisionBaseline = batch ? null : await require('./revision-review').createBaseline(db, contract, actorId);
  const historyVersions = batch ? await db('la_versions').whereIn('contract_id', [...new Set(documents.map(d=>d.contractId))]).orderBy('created_at','desc').limit(200).select('id','contract_id','version_no','filename','sha256','parent_id','source_action','created_at') : [];
  const manifest = { engine: ENGINE, documents, laws: await localLawCatalog(), ...(batch ? { autoReviewBatchId: batch.id, unavailableDocuments: batch.unavailable, historyVersions } : {}), ...(jointGroup ? { jointGroup } : {}), ...(revisionBaseline ? { revisionBaseline } : {}) };
  const session = (await db('la_agent_sessions').insert({ id: randomUUID(), contract_id: contract.id, version_id: contract.current_version_id, created_by: actorId, manifest: JSON.stringify(manifest) }).returning('*'))[0];
  return beginRun(db, session, actorId, content, { clientKey });
}
async function assertActive(db, reviewId) {
  const run = await db('la_reviews').where({ id: reviewId }).first();
  if (!run || !['running', 'queued'].includes(run.status)) fail(409, 'AGENT_STOPPED', '本轮审查已停止');
  const actor = await db('la_users').where({ id: run.created_by, active: true }).first();
  if (!actor || !hasRole(actor, 'business', 'legal')) fail(403, 'AGENT_ACCESS_REVOKED', '发起人的访问权限已失效');
  const contract = await accessible(db, actor, run.contract_id);
  const session = await db('la_agent_sessions').where({ id: run.agent_session_id }).first();
  if (contract.current_version_id !== run.version_id || contract.current_review_id !== run.id || session.current_review_id !== run.id) fail(409, 'AGENT_VERSION_CHANGED', '任务已不是当前文件或当前审查版本');
  if (run.snapshot.autoReviewBatchId) await require('../auto-review-batch').assertCurrent(db, run.snapshot.autoReviewBatchId);
  else await require('../joint-intake').assertCurrent(db, contract, run.snapshot);
  for (const d of run.snapshot.documents) await accessible(db, actor, d.contractId);
  for (const id of run.snapshot.revisionBaseline?.accessContractIds || []) await accessible(db, actor, id);
  if (run.snapshot.model) assertModelSnapshot(await providerConfig(db), run.snapshot.model);
  const ids = run.snapshot.memoryIds || [];
  if (ids.length) {
    const q = db('la_agent_memories as m').leftJoin('la_agent_legal_events as e', 'e.id', 'm.source_id').whereIn('m.id', ids).select('m.*', 'e.revoked_at').orderBy('m.id');
    if (db.isTransaction) q.forShare('m');
    const current = await q;
    const latest = await db('la_reviews').where({ id: run.id }).first();
    if (latest.coverage?.requiresRecheck || current.length !== ids.length || current.some(m => m.state !== 'active' || m.revoked_at || m.department !== (contract.department || '') || m.version !== run.snapshot.memories?.find(old => old.id === m.id)?.version || !!m.is_system !== !!run.snapshot.memories?.find(old => old.id === m.id)?.is_system)) fail(409, 'AGENT_MEMORY_REVOKED', '本轮引用的知识已更新、切换分类、停用或删除，请重新审查');
  }
  return { run, session, actor, contract };
}
async function prepareDocuments(db, run, parser, convert) {
  const docs = [];
  for (const entry of run.snapshot.documents) {
    await assertActive(db, run.id);
    let v = await db('la_versions').where({ id: entry.versionId, sha256: entry.sha256 }).first();
    if (!v) fail(409, 'AGENT_DOCUMENT_CHANGED', '固定文件版本已变化或不存在');
    const storage = require('../storage');
    if (storage.sha256(await storage.read(v.storage_key)) !== entry.sha256) fail(409, 'FILE_INTEGRITY', '合同文件完整性校验失败');
    const { needsConversion } = require('../file-formats'), { ensureConverted, parseConverted, persistDocument } = require('../conversion');
    if (!v.parsed && needsConversion(v.filename)) v = await ensureConverted(db, v, { convert });
    const document = v.parsed || (needsConversion(v.filename) ? await parseConverted(v, parser) : await require('../pdf-layout').parseVersion(db, v, parser));
    if (!v.parsed) await persistDocument(db, v, document);
    if (!document.blocks?.length) fail(422, 'AGENT_EMPTY_DOCUMENT', `${v.filename} 未识别到正文`);
    docs.push({ ...entry, blocks: document.blocks.map(({ id, text, page, table, row, column }) => ({ id, text, ...(page ? { page } : {}), ...(table ? { table, row, column } : {}) })), warnings: document.warnings || [], requiresHumanVerification: !!document.requiresHumanVerification });
  }
  return docs;
}
async function processReview(db, reviewId, options = {}) {
  let run = await db('la_reviews').where({ id: reviewId }).first();
  if (!run || !['queued', 'running'].includes(run.status)) return;
  if (run.engine !== ENGINE) fail(409, 'REVIEW_ENGINE_RETIRED', '旧审查引擎已退役，请创建新的 Agent 审查');
  const connection = await db.client.acquireConnection();
  const lock = await db.raw('SELECT pg_try_advisory_lock(hashtext(?)) AS locked', ['agent:' + run.agent_session_id]).connection(connection);
  if (!lock.rows[0].locked) { await db.client.releaseConnection(connection); return; }
  if (!options.batchBackupLocked) await db.raw('SELECT pg_advisory_lock_shared(hashtext(?))', ['legal-data-backup']).connection(connection);
  let runtime;
  const notify = async (type, data = {}) => { const e = await event(db, run.agent_session_id, run.id, type, data); await options.notify?.(run.contract_id, { reviewId: run.id, sessionId: run.agent_session_id, type, eventId: e.id }); };
  try {
    ({ run } = await assertActive(db, run.id));
    if (options.runtimeFactory) {
      run.snapshot = { ...run.snapshot, mockOnly: true };
      await db('la_reviews').where({ id: run.id }).update({ snapshot: JSON.stringify(run.snapshot) });
    }
    if (!run.snapshot.model && !options.runtimeFactory) fail(422, 'MODEL_NOT_CONFIGURED', '请先配置支持工具调用的模型网关');
    await db('la_reviews').where({ id: run.id }).update({ status: 'running', stage: 'reading_materials', error_code: null, error_message: null, updated_at: db.fn.now() });
    await db('la_agent_sessions').where({ id: run.agent_session_id }).update({ status: 'running', updated_at: db.fn.now() });
    await notify('started', { message: '正在读取合同与关联材料' });
    const documents = await prepareDocuments(db, run, options.parser || require('../parser').parseDocument, options.convert);
    const context = await require('./tools').createToolContext(db, run.id, documents, { ...options, notify });
    const savedQuestion = await db('la_agent_messages').where({ review_id: run.id, kind: 'question' }).first();
    if (savedQuestion) {
      await db('la_reviews').where({ id: run.id }).update({ status: 'waiting_input', stage: 'awaiting_answer', updated_at: db.fn.now() });
      await db('la_agent_sessions').where({ id: run.agent_session_id }).update({ status: 'waiting_input', updated_at: db.fn.now() });
      await notify('waiting_input', { message: savedQuestion.content });
      return;
    }
    const observationComplete = !run.snapshot.autoReviewBatchId || (await db('la_auto_review_batches').where({ id: run.snapshot.autoReviewBatchId }).first())?.quality_gate?.observedReviewId === run.id;
    if (run.agent_result && !savedQuestion && observationComplete) {
      const report = require('./schemas').report.parse(run.agent_result);
      const savedSession = await db('la_agent_sessions').where({ id: run.agent_session_id }).first();
      await finalize(db, run, report, documents, savedSession.read_ranges);
      await notify('completed', { message: '已恢复提交前保存的审查结果' });
      return;
    }
    await context.prepareRequiredSkills();
    const factory = options.runtimeFactory || require('./runtime').createRuntime;
    runtime = await factory({ db, run, documents, context, notify });
    const msg = await db('la_agent_messages').where({ review_id: run.id, role: 'user' }).orderBy('created_at').first();
    const result = await runtime.run(msg?.content || '从已保存的工作继续审查。');
    if (context.generatedVersion) {
      const artifact = context.generatedVersion;
      await db('la_reviews').where({ id: run.id }).update({
        status: 'completed', stage: 'artifact_generated', progress: 100,
        agent_result: JSON.stringify({ summary: `已生成批注建议稿 v${artifact.versionNo}。原始文件保持不变，修改稿将进入新的预审流程。`, contractType: '', reviewedVersionIds: [artifact.sourceVersionId], limitations: artifact.unlocatedFindingIds?.length ? [`有 ${artifact.unlocatedFindingIds.length} 条意见无法可靠定位，未写入对应正文位置。`] : [], findings: [] }),
        coverage: JSON.stringify({ complete: true, generatedVersionId: artifact.versionId }),
        error_code: null, error_message: null, updated_at: db.fn.now(),
      });
      await db('la_agent_sessions').where({ id: run.agent_session_id }).update({ status: 'completed', updated_at: db.fn.now() });
      await notify('completed', { message: `批注建议稿已保存为 v${artifact.versionNo}，新版本已进入重新预审流程`, artifact });
      return;
    }
    await assertActive(db, run.id);
    const session = await db('la_agent_sessions').where({ id: run.agent_session_id }).first();
    const latest = await db('la_reviews').where({ id: run.id }).first();
    const question = await db('la_agent_messages').where({ review_id: run.id, kind: 'question' }).first();
    if (context.report && !question) {
      await finalize(db, run, context.report, documents, session.read_ranges);
      await notify('completed', { message: '本轮审查已完成，可继续追问或由法务确认结论' });
    } else {
      const content = question?.content || result?.text || '本轮尚未提交完整审查结果，可继续审查。';
      await db('la_reviews').where({ id: run.id }).update({ status: 'waiting_input', stage: question ? 'awaiting_answer' : 'paused', coverage: JSON.stringify({ ...coverage(documents, session.read_ranges), complete: false }), error_code: latest.error_code || (question ? null : 'AGENT_INCOMPLETE'), error_message: latest.error_message || null, updated_at: db.fn.now() });
      await db('la_agent_sessions').where({ id: session.id }).update({ status: 'waiting_input', updated_at: db.fn.now() });
      if (!question) await db('la_agent_messages').insert({ id: randomUUID(), session_id: session.id, review_id: run.id, role: 'assistant', content, kind: 'progress' });
      await notify('waiting_input', { message: content });
    }
  } catch (e) {
    const current = await db('la_reviews').where({ id: run.id }).first();
    if (current?.status !== 'cancelled') {
      const pause = ['AGENT_BUDGET', 'AGENT_TIMEOUT', 'AGENT_NO_PROGRESS', 'AGENT_MODEL_TIMEOUT', 'AGENT_MODEL_CONNECTION', 'AGENT_MODEL_HTTP'].includes(e.code);
      await db('la_reviews').where({ id: run.id }).update({ status: pause ? 'waiting_input' : 'failed', stage: pause ? 'paused' : 'failed', error_code: e.code || 'HARNESS_RUNTIME_FAILED', error_message: e.code ? e.message : 'Agent 运行中断，已保留会话，可恢复后继续。', updated_at: db.fn.now() });
      await db('la_agent_sessions').where({ id: run.agent_session_id, current_review_id: run.id }).update({ status: pause ? 'waiting_input' : 'failed', updated_at: db.fn.now() });
      await notify(pause ? 'paused' : 'failed', { code: e.code || 'HARNESS_RUNTIME_FAILED', message: e.code ? e.message : 'Agent 运行中断，已保存工作' });
    }
  } finally {
    await runtime?.close?.().catch(() => {});
    if (!options.batchBackupLocked) await db.raw('SELECT pg_advisory_unlock_shared(hashtext(?))', ['legal-data-backup']).connection(connection).catch(() => {});
    await db.raw('SELECT pg_advisory_unlock(hashtext(?))', ['agent:' + run.agent_session_id]).connection(connection).catch(() => {});
    await db.client.releaseConnection(connection);
  }
}
async function finalize(db, run, report, documents, ranges) {
  await db.transaction(async trx => {
    // Cancellation and publication take the batch lock first in the same order.
    let batchSnapshot = {};
    if (run.snapshot.autoReviewBatchId) {
      const batch = await trx('la_auto_review_batches').where({ id: run.snapshot.autoReviewBatchId }).forUpdate().first();
      if (batch.main_review_id !== run.id || batch.quality_gate.observedReviewId !== run.id) fail(422, 'AUTO_REVIEW_QUALITY_GATE', '自动批次报告尚未通过当前轮次观察');
      batchSnapshot = { autoReviewPlan: batch.execution_plan, autoReviewQualityGate: batch.quality_gate };
    }
    const contract = await accessible(trx, await trx('la_users').where({ id: run.created_by }).first(), run.contract_id, true);
    await assertActive(trx, run.id);
    await systemSkills.assertLoaded(trx, run);
    const latest = await trx('la_reviews').where({ id: run.id }).forUpdate().first();
    if (latest.status !== 'running') fail(409, 'AGENT_STOPPED', '本轮审查已停止');
    const sources = await trx('la_agent_sources as s').join('la_reviews as r', 'r.id', 's.review_id').where('r.agent_session_id', run.agent_session_id).select('s.*');
    if (!await trx('la_findings').where({ review_id: run.id }).first()) for (const f of report.findings) await trx('la_findings').insert({
      id: randomUUID(), review_id: run.id, rule_id: null, title: f.title, check_status: f.status, severity: f.severity, kind: f.kind,
      reason: f.reason, suggestion: f.suggestion, evidence: JSON.stringify(f.evidence), legal_refs: JSON.stringify(sources.filter(s => f.legalSourceIds.includes(s.id)).map(s => ({ id: s.id, title: s.title, content: s.content, source: s.url || '内部法律资料', effectiveDate: s.effective_date || '', validity: s.validity, fetchedAt: s.fetched_at, sha256: s.sha256 }))),
    });
    await trx('la_reviews').where({ id: run.id }).update({ status: 'completed', stage: run.snapshot.autoReviewBatchId ? 'completed' : 'awaiting_human_review', progress: 100, agent_result: JSON.stringify(report), coverage: JSON.stringify(coverage(documents, ranges)), snapshot: JSON.stringify({ ...run.snapshot, ...batchSnapshot, knowledge: sources.map(s => ({ id: s.id, title: s.title, source: s.url, content: s.content })) }), error_code: null, error_message: null, updated_at: trx.fn.now() });
    const classification = require('./classification').classificationForReport(contract, run, report);
    if (classification) await trx('la_contracts').where({ id: contract.id }).update({ classification: JSON.stringify(classification), revision: trx.raw('revision + 1'), updated_at: trx.fn.now() });
    await trx('la_agent_sessions').where({ id: run.agent_session_id }).update({ status: 'completed', updated_at: trx.fn.now() });
    await trx('la_agent_messages').insert({ id: randomUUID(), session_id: run.agent_session_id, review_id: run.id, role: 'assistant', kind: 'result', content: report.summary, data: JSON.stringify({ limitations: report.limitations }) });
  });
}
async function recover(db) {
  const rows = await db('la_reviews').where({ engine: ENGINE, status: 'running' });
  for (const run of rows) {
    if (run.snapshot?.autoReviewBatchId) continue; // Batch recovery owns these tasks.
    const connection = await db.client.acquireConnection();
    try {
      const lock = await db.raw('SELECT pg_try_advisory_lock(hashtext(?)) AS locked', ['agent:' + run.agent_session_id]).connection(connection);
      if (!lock.rows[0].locked) continue;
      try { await db.transaction(async trx => {
        const latest = await trx('la_reviews').where({ id: run.id }).forUpdate().first();
        if (latest.status !== 'running') return;
        await trx('la_reviews').where({ id: run.id }).update({ status: 'queued', stage: 'recovering', updated_at: trx.fn.now() });
        await trx('la_outbox').insert({ id: randomUUID(), queue: 'agent-review', payload: JSON.stringify({ reviewId: run.id }) });
      }); } finally { await db.raw('SELECT pg_advisory_unlock(hashtext(?))', ['agent:' + run.agent_session_id]).connection(connection); }
    } finally { await db.client.releaseConnection(connection); }
  }
}
module.exports = { createSession, beginRun, sessionFor, assertActive, processReview, prepareDocuments, usableMemories, recover, event };
