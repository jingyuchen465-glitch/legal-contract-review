const { randomUUID } = require('node:crypto');
const storage = require('./storage');
const { parseDocument } = require('./parser');
const { createGateway, providerConfig, publicModelSnapshot, assertModelSnapshot } = require('./model');
const { classificationGuidance } = require('./model');
const { matchRules } = require('./rules');
const { catalogVersion } = require('./catalog');
const { audit } = require('./auth');
async function enqueueReview(db, c, actorId, { mode } = {}) {
  // New document/background/classification revisions retain an explicit trial choice.
  // POST /reviews always supplies a mode, so users can deliberately start a formal run.
  mode ||= c.current_review_id ? (await db('la_reviews').where({ id: c.current_review_id }).first())?.snapshot?.reviewMode || 'formal' : 'formal';
  const id = randomUUID();
  const configuredModel = await providerConfig(db);
  // Pin every eligible pack before classification, so publication cannot change
  // the standards of a queued task. Match the applicable subset after classifying.
  const snapshot = { reviewMode: mode, classificationGuidance: await classificationGuidance(db), model: configuredModel.baseUrl && configuredModel.name ? publicModelSnapshot(configuredModel) : null, ...(mode === 'trial' ? { examplePacks: require('./seeds').examplePacks() } : { publishedPacks: await db('la_rule_versions').where({ state: 'published' }).orderBy('published_at', 'desc') }) };
  await db('la_reviews').insert({ id, contract_id: c.id, version_id: c.current_version_id, created_by: actorId, snapshot: JSON.stringify(snapshot) });
  await audit(db, { id: actorId }, 'review.create', id, { mode, contractId: c.id, versionId: c.current_version_id });
  await db('la_contracts').where({ id: c.id }).update({ current_review_id: id, legal_status: 'pending_review', revision: db.raw('revision + 1'), updated_at: db.fn.now() });
  await db('la_outbox').insert({ id: randomUUID(), queue: 'review', payload: JSON.stringify({ reviewId: id }) });
  return id;
}
async function processReview(db, reviewId, { gateway, parser = parseDocument, notify = () => {} } = {}) {
  let review = await db('la_reviews').where({ id: reviewId }).first(); if (!review || ['completed', 'cancelled'].includes(review.status)) return;
  const c = await db('la_contracts').where({ id: review.contract_id }).first();
  const v = await db('la_versions').where({ id: review.version_id }).first();
  const customGateway = !!gateway;
  gateway ||= createGateway(db, { pinnedModel: review.snapshot?.model, pinnedClassificationGuidance: review.snapshot?.classificationGuidance });
  const step = async (stage, progress, details = {}) => {
    await db.transaction(async trx => {
      const latest = await trx('la_reviews').where({ id: reviewId }).forUpdate().first();
      if (latest.status === 'cancelled') { const { fail } = require('./errors'); fail(409, 'REVIEW_CANCELLED', '任务已取消'); }
      await trx('la_reviews').where({ id: reviewId }).update({ status: 'running', stage, progress, error_code: null, error_message: null, updated_at: trx.fn.now() });
      await trx('la_job_steps').insert({ review_id: reviewId, stage, status: 'running', details: JSON.stringify(details) });
    }); await notify(c.id, { reviewId, status: 'running', stage, progress });
  };
  const trace = async details => {
    await db('la_job_steps').insert({ review_id: reviewId, stage: 'model_call', status: 'completed', details: JSON.stringify(details) });
    if ((await db('la_reviews').where({ id: reviewId }).first())?.status === 'cancelled') { const { fail } = require('./errors'); fail(409, 'REVIEW_CANCELLED', '任务已取消'); }
    if (details.label === 'review' && details.ruleBatchCount && details.chunkCount) {
      const fraction = ((details.chunkIndex - 1) * details.ruleBatchCount + details.ruleBatchIndex) / (details.chunkCount * details.ruleBatchCount);
      const progress = 55 + Math.round(fraction * 30);
      await db('la_reviews').where({ id: reviewId, status: 'running' }).update({ progress, updated_at: db.fn.now() });
      notify(c.id, { reviewId, status: 'running', stage: 'reviewing', progress });
    }
  };
  try {
    await step('extracting', 10);
    const document = v.parsed || await parser(await storage.read(v.storage_key), v.filename);
    if (!v.parsed) await db('la_versions').where({ id: v.id }).update({ parsed: JSON.stringify(document) });
    if (!c.background.ourEntity || !c.background.perspective || !c.background.purpose) { const { fail } = require('./errors'); fail(422, 'BACKGROUND_REQUIRED', '请补充我方主体、交易立场和交易目的'); }
    if (!customGateway && !review.snapshot?.model) { const { fail } = require('./errors'); fail(422, 'MODEL_SNAPSHOT_MISSING', '该预审缺少模型配置快照，请创建新的预审任务'); }
    await step('classifying', 25);
    // A run's immutable snapshot is reused on retries; a later publication never changes this run.
    let snapshot = review.snapshot;
    if (!snapshot.rules) {
      const guidance = snapshot.classificationGuidance || await classificationGuidance(db);
      snapshot = { ...snapshot, classificationGuidance: guidance };
      await db('la_reviews').where({ id: reviewId }).update({ snapshot: JSON.stringify(snapshot) });
      if (!customGateway) gateway = createGateway(db, { pinnedModel: snapshot.model, pinnedClassificationGuidance: guidance });
      const classification = c.classification?.confirmed && c.classification.versionId === v.id ? c.classification : await gateway.classify(document, 'llm', trace);
      classification.versionId = v.id;
      await db.transaction(async trx => {
        const latest = await trx('la_contracts').where({ id: c.id }).forUpdate().first();
        if (latest.current_version_id === v.id && latest.current_review_id === reviewId && !latest.classification?.confirmed) await trx('la_contracts').where({ id: c.id }).update({ classification: JSON.stringify(classification), revision: trx.raw('revision + 1') });
      });
      await step('matching_rules', 40);
      const mode = snapshot.reviewMode || 'formal';
      const matched = await matchRules(db, classification, mode === 'trial' ? snapshot.examplePacks : snapshot.publishedPacks, { mode }); const p = await providerConfig(db);
      if (!customGateway) assertModelSnapshot(p, snapshot.model);
      const retrieved = await require('./retrieval').retrieveKnowledge(db, document, matched, { trace });
      snapshot = { ...snapshot, ...matched, ...retrieved, classification, classificationGuidance: guidance, catalogVersion, parserVersion: document.parserVersion, promptVersion: 'review-1.1', background: c.background, versionId: v.id, fileHash: v.sha256 };
      await db('la_reviews').where({ id: reviewId }).update({ snapshot: JSON.stringify(snapshot) });
    }
    if (!customGateway) gateway = createGateway(db, { pinnedModel: snapshot.model, pinnedClassificationGuidance: snapshot.classificationGuidance });
    await step('reviewing', 55);
    const result = await gateway.review(document, snapshot.rules, snapshot.knowledge, snapshot.background, trace);
    await step('validating', 90);
    // The last provider response is only usable if the configuration is still
    // the task's pinned snapshot immediately before persisting findings.
    if (!customGateway) assertModelSnapshot(await providerConfig(db), snapshot.model);
    await db.transaction(async trx => {
      const latest = await trx('la_reviews').where({ id: reviewId }).forUpdate().first();
      if (latest.status === 'cancelled') { const { fail } = require('./errors'); fail(409, 'REVIEW_CANCELLED', '任务已取消'); }
      const claimed = await trx('la_reviews').where({ id: reviewId, status: 'running' }).update({ stage: 'finalizing', updated_at: trx.fn.now() });
      if (!claimed) { const { fail } = require('./errors'); fail(409, 'REVIEW_CANCELLED', '任务已取消'); }
      const existing = await trx('la_findings').where({ review_id: reviewId }).first();
      if (!existing) for (const check of result.checks) await trx('la_findings').insert({ id: randomUUID(), review_id: reviewId, rule_id: check.ruleId, title: check.title, check_status: check.status, severity: check.severity, kind: check.kind, reason: check.reason, suggestion: check.suggestion, evidence: JSON.stringify(check.evidence), legal_refs: JSON.stringify(check.legalRefIds.map(id => snapshot.knowledge.find(k => k.id === id))) });
      if (!existing && document.requiresHumanVerification) await trx('la_findings').insert({ id: randomUUID(), review_id: reviewId, rule_id:'parser-verification', title:'原文识别或修订需人工核实',check_status:'uncertain',severity:'high',kind:'uncertain',reason:document.warnings.join('\n'),suggestion:'核实扫描内容中的主体、日期、金额或原文修订，并记录处理意见。',evidence:'[]',legal_refs:'[]' });
      await trx('la_reviews').where({ id: reviewId }).update({ status: 'completed', stage: 'awaiting_human_review', progress: 100, coverage: JSON.stringify({ ...result.coverage, parseWarnings: document.warnings || [] }), revision: trx.raw('revision + 1'), updated_at: trx.fn.now() });
      await trx('la_job_steps').insert({ review_id: reviewId, stage: 'complete', status: 'completed' });
    });
    // Completion is already committed. Exporting a convenience copy is a
    // separate side effect and must never downgrade the completed task.
    try {
      const current = await db('la_contracts').where({ id: c.id }).first();
      if (current.current_version_id === v.id) await storage.exportVersion(current, v);
    } catch (exportError) {
      try { await db('la_job_steps').insert({ review_id: reviewId, stage: 'export', status: 'failed', details: JSON.stringify({ code: exportError.code || 'EXPORT_FAILED' }) }); } catch {}
      try { await notify(c.id, { reviewId, status: 'completed', progress: 100, exportError: '导出文件失败，请从任务报告重新下载' }); } catch {}
      return;
    }
    try { await notify(c.id, { reviewId, status: 'completed', progress: 100 }); } catch {}
  } catch (e) {
    if (e.code === 'REVIEW_CANCELLED' || (await db('la_reviews').where({ id: reviewId }).first())?.status === 'cancelled') return;
    const status = e.status && e.status < 500 ? 'waiting_input' : 'failed';
    const message = e.code ? e.message : '处理失败，请查看任务编号并联系管理员';
    await db('la_reviews').where({ id: reviewId }).update({ status, error_code: e.code || 'PROCESSING_FAILED', error_message: message, updated_at: db.fn.now() });
    await db('la_job_steps').insert({ review_id: reviewId, stage: 'error', status, details: JSON.stringify({ code: e.code || 'PROCESSING_FAILED' }) });
    notify(c.id, { reviewId, status, error: message });
    if (status === 'failed') throw e;
  }
}
// Hold a session advisory lock while a run executes. A killed worker releases it automatically.
async function processReviewExclusive(db,id,options){const connection=await db.client.acquireConnection();try{await db.raw('SELECT pg_advisory_lock(hashtext(?))',[`review:${id}`]).connection(connection);return await processReview(db,id,options);}finally{await db.raw('SELECT pg_advisory_unlock(hashtext(?))',[`review:${id}`]).connection(connection).catch(()=>{});await db.client.releaseConnection(connection);}}
module.exports = { enqueueReview, processReview:processReviewExclusive };
