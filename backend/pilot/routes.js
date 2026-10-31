const express = require('express');
const multer = require('multer');
const crypto = require('node:crypto');
const { z } = require('zod');
const { config } = require('./config');
const { wrap, fail } = require('./errors');
const { catalog, tags, findType, catalogVersion } = require('./catalog');
const { roles, publicUser, hashPassword, hasRole, requireRole, accessible, assertRevision, audit } = require('./auth');
const { createContract, addVersion } = require('./contracts');
const { enqueueReview } = require('./workflow');
const { createDraft, packSchema, catalogWithAvailability } = require('./rules');
const settingsService = require('./settings');
const storage = require('./storage');
const { htmlReport, reportData, legacy } = require('./reports');
// Browsers send multipart filenames as UTF-8, including names without filename*.
const upload = multer({ storage: multer.memoryStorage(), defParamCharset: 'utf8', limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 20 } });
const uuid = z.string().uuid();
const backgroundSchema = z.object({ ourEntity: z.string().max(200), perspective: z.string().max(200), purpose: z.string().max(3000) });
const revisionOf = req => z.coerce.number().int().positive().parse(req.body.revision);
const jsonField = (value, fallback = {}) => { if (!value) return fallback; try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { fail(400, 'INVALID_JSON', '表单 JSON 字段无效'); } };
const publicVersion = v => { const { storage_key, ...result } = v; return result; };
async function readReview(db, user, id) { uuid.parse(id); const run = await db('la_reviews').where({ id }).first(); if (!run) fail(404, 'REVIEW_NOT_FOUND', '预审任务不存在'); const c = await accessible(db, user, run.contract_id); return { run, c }; }
function assertCurrent(c, run) { if (c.current_review_id !== run.id || c.current_version_id !== run.version_id) fail(409, 'STALE_REVIEW', '该任务已不是当前版本，请在最新预审中处理'); }
async function assertReviewWritable(trx, c, run) {
  if (c.legal_status === 'returned' || await trx('la_returns').where({ review_id: run.id, version_id: run.version_id }).first()) fail(409, 'CONTRACT_RETURNED', '该预审已退回，请上传修改版本或创建新的预审任务');
}
function router(db) {
  const r = express.Router();
  require('./feedback').mountFeedbackRoutes(r, db);
  require('./classification-guidance').mountGuidanceRoutes(r, db);
  r.get('/catalog', wrap(async (req, res) => res.json({ categories: await catalogWithAvailability(db), tags, version: catalogVersion })));
  r.get('/contracts', wrap(async (req, res) => {
    const paginated = req.query.page !== undefined, page = paginated ? z.coerce.number().int().min(1).max(1000000).parse(req.query.page) : 1;
    const q = db('la_contracts');
    if (!hasRole(req.user, 'admin') && !(hasRole(req.user, 'legal') && req.user.department === '*')) q.where(function () { this.where('submitter_id', req.user.id).orWhere('reviewer_id', req.user.id); if (hasRole(req.user, 'legal') && req.user.department) this.orWhere('department', req.user.department); });
    if (req.query.q) { const term = `%${String(req.query.q).slice(0, 100)}%`; q.where(function () { this.whereILike('title', term).orWhereILike('number', term); }); }
    if (req.query.status) q.where('legal_status', z.enum(['pending_review','in_review','returned','finalized','archived']).parse(req.query.status));
    if (req.query.source) q.where('source', z.enum(['manual','dingtalk']).parse(req.query.source));
    const view = z.enum(['main', 'reconciliation-pending', 'all']).default('main').parse(req.query.view || 'main');
    const requestedIntakeMode = req.query.intakeMode || req.query.intake_mode;
    const requestedIntakeReviewStatus = req.query.intakeReviewStatus || req.query.intake_review_status;
    const intakeMode = requestedIntakeMode ? z.enum(['live', 'reconciliation', 'manual']).parse(requestedIntakeMode) : null;
    const intakeReviewStatus = requestedIntakeReviewStatus ? z.enum(['confirmed', 'pending', 'dismissed']).parse(requestedIntakeReviewStatus) : null;
    if (view === 'reconciliation-pending') q.where({ intake_mode: 'reconciliation', intake_review_status: 'pending' });
    else if (view !== 'all') q.where(function () { this.whereNot('intake_mode', 'reconciliation').orWhere('intake_review_status', 'confirmed'); });
    if (intakeMode) q.where('intake_mode', intakeMode);
    if (intakeReviewStatus) q.where('intake_review_status', intakeReviewStatus);
    if (req.query.type) q.whereRaw("classification->>'typeId' = ?", [String(req.query.type).slice(0,100)]);
    if (req.query.reviewer) req.query.reviewer === 'unassigned' ? q.whereNull('reviewer_id') : q.where('reviewer_id', uuid.parse(req.query.reviewer));
    const total = paginated ? Number((await q.clone().count('* as count').first()).count) : undefined;
    const rows = await q.orderBy('updated_at', 'desc').limit(paginated ? 50 : 200).offset(paginated ? (page - 1) * 50 : 0);
    const runs = rows.length ? await db('la_reviews').whereIn('id', rows.map(c => c.current_review_id).filter(Boolean)) : [];
    const attachmentCounts = rows.length ? await db('la_attachments').select('contract_id').count('* as n').whereIn('contract_id', rows.map(c => c.id)).groupBy('contract_id') : [];
    const countByContract = new Map(attachmentCounts.map(row => [row.contract_id, Number(row.n)]));
    const items = rows.map(c => ({
      ...c,
      review: runs.find(x => x.id === c.current_review_id) || null,
      approvalTitle: c.source_data?.title || c.title,
      receivedAt: c.created_at,
      intakeReason: c.source_data?.reconciliationReason || (c.intake_mode === 'reconciliation' ? '接入后历史审批补查' : ''),
      attachmentCount: countByContract.get(c.id) || 0,
    }));
    res.json(paginated ? { items, total, page, pageSize: 50 } : items);
  }));
  r.post('/contracts/upload', requireRole('business', 'legal'), upload.single('file'), wrap(async (req, res) => {
    const background = backgroundSchema.parse(jsonField(req.body.background));
    const result = await db.transaction(async trx => { const value = await createContract(trx, req.user, req.file, { title: req.body.title, background }); await audit(trx, req.user, 'contract.upload', value.contract.id); return value; });
    res.status(201).json({ ...result, version: publicVersion(result.version) });
  }));
  r.get('/contracts/:id', wrap(async (req, res) => {
    uuid.parse(req.params.id); const c = await accessible(db, req.user, req.params.id);
    const versions = await db('la_versions').where({ contract_id: c.id }).orderBy('version_no', 'desc');
    const reviews = await db('la_reviews').where({ contract_id: c.id }).orderBy('created_at', 'desc');
    const decisions = reviews.length ? await db('la_decisions').whereIn('review_id', reviews.map(r => r.id)) : [];
    await audit(db, req.user, 'contract.view', c.id);
    res.json({ ...c, versions: versions.map(publicVersion), reviews, decisions, returns: reviews.length ? await db('la_returns').whereIn('review_id', reviews.map(r => r.id)).orderBy('created_at','desc') : [], archives: await db('la_archives').where({ contract_id: c.id }) });
  }));
  r.post('/contracts/:id/intake-confirm', requireRole('legal'), wrap(async (req, res) => {
    const note = z.string().max(2000).default('').parse(req.body.note || '');
    const updated = await db.transaction(async trx => {
      const c = await accessible(trx, req.user, uuid.parse(req.params.id), true);
      assertRevision(c, revisionOf(req));
      if (c.intake_mode !== 'reconciliation' || c.intake_review_status !== 'pending') fail(409, 'INTAKE_STATE', '该合同不在补查待确认列表');
      await trx('la_contracts').where({ id: c.id }).update({ intake_review_status: 'confirmed', intake_reviewed_by: req.user.id, intake_reviewed_at: trx.fn.now(), intake_review_note: note, revision: trx.raw('revision + 1'), updated_at: trx.fn.now() });
      await audit(trx, req.user, 'contract.intake_confirm', c.id, { note });
      return trx('la_contracts').where({ id: c.id }).first();
    });
    res.json(updated);
  }));
  r.post('/contracts/:id/intake-dismiss', requireRole('legal'), wrap(async (req, res) => {
    const note = z.string().max(2000).default('').parse(req.body.note || '');
    const updated = await db.transaction(async trx => {
      const c = await accessible(trx, req.user, uuid.parse(req.params.id), true);
      assertRevision(c, revisionOf(req));
      if (c.intake_mode !== 'reconciliation' || c.intake_review_status !== 'pending') fail(409, 'INTAKE_STATE', '该合同不在补查待确认列表');
      await trx('la_contracts').where({ id: c.id }).update({ intake_review_status: 'dismissed', intake_reviewed_by: req.user.id, intake_reviewed_at: trx.fn.now(), intake_review_note: note, revision: trx.raw('revision + 1'), updated_at: trx.fn.now() });
      await audit(trx, req.user, 'contract.intake_dismiss', c.id, { note });
      return trx('la_contracts').where({ id: c.id }).first();
    });
    res.json(updated);
  }));
  r.patch('/contracts/:id/background', requireRole('business', 'legal'), wrap(async (req, res) => {
    const background = backgroundSchema.parse(req.body.background);
    const row = await db.transaction(async trx => { const c = await accessible(trx, req.user, uuid.parse(req.params.id), true); assertRevision(c, revisionOf(req)); await trx('la_contracts').where({ id: c.id }).update({ background: JSON.stringify(background), classification: c.classification ? JSON.stringify({ ...c.classification, perspectiveConfirmed: false }) : null, revision: trx.raw('revision + 1') }); const id = await enqueueReview(trx, c, req.user.id); await audit(trx, req.user, 'contract.background', c.id); return { reviewId: id }; }); res.json(row);
  }));
  r.post('/contracts/:id/versions', requireRole('business', 'legal'), upload.single('file'), wrap(async (req, res) => {
    const result = await db.transaction(async trx => { const c = await accessible(trx, req.user, uuid.parse(req.params.id), true); assertRevision(c, revisionOf(req)); const kind = ['signed', 'supplement'].includes(req.body.kind) ? req.body.kind : 'contract'; const value = await addVersion(trx, c, req.file, req.user.id, 'upload', kind); await audit(trx, req.user, 'contract.version', c.id, { versionId: value.version.id, kind }); return value; });
    res.status(result.duplicate ? 200 : 201).json({ ...result, version: publicVersion(result.version) });
  }));
  r.put('/contracts/:id/classification', requireRole('legal'), wrap(async (req, res) => {
    const value = z.object({ typeId: z.string(), tags: z.array(z.enum(tags)), perspectiveConfirmed: z.literal(true) }).parse(req.body);
    if (!findType(value.typeId)) fail(400, 'UNKNOWN_TYPE', '请选择目录内合同类型');
    const result = await db.transaction(async trx => {
      const c = await accessible(trx, req.user, uuid.parse(req.params.id), true); assertRevision(c, revisionOf(req));
      if (!c.background.ourEntity || !c.background.perspective || !c.background.purpose) fail(400, 'BACKGROUND_REQUIRED', '请先补充我方主体、立场和业务目的');
      const changed = c.classification?.typeId !== value.typeId || JSON.stringify([...(c.classification?.tags || [])].sort()) !== JSON.stringify([...value.tags].sort());
      const classification = { ...c.classification, ...value, versionId: c.current_version_id, confirmed: true, confirmedBy: req.user.id, confirmedAt: new Date().toISOString() };
      await trx('la_contracts').where({ id: c.id }).update({ classification: JSON.stringify(classification), revision: trx.raw('revision + 1') });
      const reviewId = changed ? await enqueueReview(trx, c, req.user.id) : c.current_review_id;
      await audit(trx, req.user, 'classification.confirm', c.id, { typeId: value.typeId, changed }); return { reviewId, rerun: changed };
    });
    let archive = { status: 'not_configured' };
    try {
      const archiveConfig = await settingsService.archiveConfig(db);
      if (archiveConfig.enabled) {
        const c = await accessible(db, req.user, req.params.id);
        const v = await db('la_versions').where({ id: c.current_version_id }).first();
        const file = await storage.archiveClassifiedVersion(c, v, archiveConfig.root);
        archive = { status: 'archived', path: file };
        await audit(db, req.user, 'contract.classification_archive', c.id, { path: file, typeId: c.classification?.typeId });
      }
    } catch (error) {
      archive = { status: 'failed', message: '分类已确认，但附件自动归档失败，请检查归档目录权限' };
      await audit(db, req.user, 'contract.classification_archive_failed', req.params.id, { code: error.code || 'ARCHIVE_FAILED' });
    }
    res.json({ ...result, archive });
  }));
  r.post('/reviews', requireRole('business', 'legal'), wrap(async (req, res) => {
    const mode = z.enum(['formal', 'trial']).default('formal').parse(req.body.mode);
    const reviewId = await db.transaction(async trx => { const c = await accessible(trx, req.user, uuid.parse(req.body.contractId), true); assertRevision(c, revisionOf(req)); return enqueueReview(trx, c, req.user.id, { mode }); }); res.status(202).json({ reviewId, mode });
  }));
  r.get('/reviews/:id', wrap(async (req, res) => {
    const { run, c } = await readReview(db, req.user, req.params.id);
    res.json({ ...run, isCurrent: c.current_review_id === run.id && c.current_version_id === run.version_id, findings: await db('la_findings').where({ review_id: run.id }).orderBy('created_at'), decision: await db('la_decisions').where({ review_id: run.id }).first() || null, steps: await db('la_job_steps').where({ review_id: run.id }).orderBy('id') });
  }));
  r.post('/reviews/:id/cancel', requireRole('business', 'legal'), wrap(async (req, res) => {
    await db.transaction(async trx => { const { run } = await readReview(trx, req.user, req.params.id); const c = await accessible(trx, req.user, run.contract_id, true); assertRevision(c, revisionOf(req)); const latest = await trx('la_reviews').where({ id: run.id }).forUpdate().first(); if (!['queued','running','waiting_input','failed'].includes(latest.status)) fail(409, 'CANCEL_STATE', '当前状态不能取消'); await trx('la_reviews').where({ id: run.id }).update({ status: 'cancelled', stage: 'cancelled', updated_at: trx.fn.now() }); await audit(trx, req.user, 'review.cancel', run.id); }); res.json({ ok: true });
  }));
  r.put('/reviews/:id/findings/:findingId/disposition', requireRole('legal'), wrap(async (req, res) => {
    const input = z.object({ action: z.enum(['accept', 'reject', 'correct', 'needs_information', 'acknowledge']), reason: z.string().max(10000).default(''), suggestion: z.string().max(10000).optional(), severity: z.enum(['high', 'medium', 'low']).optional() }).parse(req.body);
    if ((input.action !== 'accept' && !input.reason.trim()) || (input.severity || input.suggestion !== undefined) && !input.reason.trim()) fail(400, 'REASON_REQUIRED', '驳回、修正或补充处理必须填写理由');
    await db.transaction(async trx => {
      const { run } = await readReview(trx, req.user, req.params.id); const c = await accessible(trx, req.user, run.contract_id, true); assertCurrent(c, run); await assertReviewWritable(trx, c, run);
      if (run.status !== 'completed' || await trx('la_decisions').where({ review_id: run.id }).first()) fail(409, 'REVIEW_LOCKED', '此预审尚未完成或已确认结论');
      const f = await trx('la_findings').where({ id: uuid.parse(req.params.findingId), review_id: run.id }).forUpdate().first(); if (!f) fail(404, 'FINDING_NOT_FOUND', '检查项不存在'); assertRevision(f, revisionOf(req));
      if (f.check_status === 'uncertain' && !input.reason.trim()) fail(400, 'REASON_REQUIRED', '确认不确定项必须填写明确的法务处理意见');
      await trx('la_findings').where({ id: f.id }).update({ disposition: JSON.stringify({ ...input, actorId: req.user.id, at: new Date().toISOString() }), revision: trx.raw('revision + 1'), updated_at: trx.fn.now() });
      await trx('la_contracts').where({ id: c.id }).update({ legal_status: 'in_review', revision: trx.raw('revision + 1') }); await audit(trx, req.user, 'finding.disposition', f.id, { action: input.action });
    }); res.json({ ok: true });
  }));
  r.post('/reviews/:id/findings', requireRole('legal'), wrap(async (req, res) => {
    const value = z.object({ title: z.string().min(1), reason: z.string().min(1), suggestion: z.string().default(''), severity: z.enum(['high', 'medium', 'low']), evidence: z.array(z.object({ blockId: z.string(), quote: z.string().min(1) })).default([]) }).parse(req.body);
    await db.transaction(async trx => { const { run } = await readReview(trx, req.user, req.params.id); const c = await accessible(trx, req.user, run.contract_id, true); assertCurrent(c, run); await assertReviewWritable(trx, c, run); if (run.status !== 'completed' || await trx('la_decisions').where({ review_id: run.id }).first()) fail(409, 'REVIEW_LOCKED', '任务尚未完成或已确认'); const v = await trx('la_versions').where({ id: run.version_id }).first(); require('./model').verifyEvidence(value.evidence, v.parsed.blocks); await trx('la_findings').insert({ id: crypto.randomUUID(), review_id: run.id, rule_id: `manual-${crypto.randomUUID()}`, title: value.title, reason: value.reason, suggestion: value.suggestion, severity: value.severity, kind: value.evidence.length ? 'clause' : 'uncertain', check_status: 'fail', evidence: JSON.stringify(value.evidence), disposition: JSON.stringify({ action: 'accept', reason: value.reason, actorId: req.user.id, at: new Date().toISOString() }) }); await trx('la_contracts').where({id:c.id}).update({revision:trx.raw('revision + 1'), legal_status:'in_review'}); await audit(trx, req.user, 'finding.add', run.id); }); res.status(201).json({ ok: true });
  }));
  r.post('/reviews/:id/return', requireRole('legal'), wrap(async (req, res) => {
    const reason = z.string().trim().min(1).max(10000).parse(req.body.reason);
    await db.transaction(async trx => { const { run } = await readReview(trx, req.user, req.params.id); const c = await accessible(trx, req.user, run.contract_id, true); assertRevision(c, revisionOf(req)); assertCurrent(c, run); if (await trx('la_decisions').where({ review_id: run.id }).first()) fail(409, 'DECISION_EXISTS', '已确认的结论不能退回覆盖，请创建新预审'); if (await trx('la_returns').where({ review_id: run.id, version_id: run.version_id }).first()) fail(409, 'CONTRACT_RETURNED', '该预审已经退回，请创建新的预审任务'); await trx('la_returns').insert({ id: crypto.randomUUID(), review_id: run.id, version_id: run.version_id, created_by: req.user.id, reason }); await trx('la_contracts').where({ id: c.id }).update({ legal_status: 'returned', revision: trx.raw('revision + 1') }); await audit(trx, req.user, 'review.return', c.id, { reason }); }); res.json({ ok: true });
  }));
  r.post('/reviews/:id/decision', requireRole('legal'), wrap(async (req, res) => {
    const value = z.object({ outcome: z.enum(['agree', 'conditional', 'disagree']), reason: z.string().max(10000).default(''), conditions: z.string().max(10000).default('') }).parse(req.body);
    if (value.outcome === 'conditional' && !value.conditions.trim() || value.outcome === 'disagree' && !value.reason.trim()) fail(400, 'DECISION_REASON', '附条件同意需填写条件，不同意需填写理由');
    const decision = await db.transaction(async trx => {
      const { run } = await readReview(trx, req.user, req.params.id); const c = await accessible(trx, req.user, run.contract_id, true); assertRevision(c, revisionOf(req)); assertCurrent(c, run); await assertReviewWritable(trx, c, run);
      if (run.snapshot.reviewMode === 'trial') fail(409, 'TRIAL_REVIEW_ONLY', '示例规则试审不能确认最终结论；请发布法务确认的规则后重新正式预审');
      if (c.legal_status === 'returned') fail(409, 'CONTRACT_RETURNED', '合同已退回，请等待新版本或重新发起预审');
      if (run.status !== 'completed' || !run.coverage.complete) fail(409, 'REVIEW_INCOMPLETE', 'AI 预审尚未完整完成');
      if (!c.classification?.confirmed || !c.classification.perspectiveConfirmed || c.classification.versionId !== run.version_id) fail(409, 'CLASSIFICATION_UNCONFIRMED', '请确认当前版本分类及我方立场');
      const findings = await trx('la_findings').where({ review_id: run.id });
      if (findings.some(f => f.disposition?.action === 'needs_information' || f.check_status !== 'pass' && !f.disposition)) fail(409, 'UNRESOLVED_FINDINGS', '仍有未处理风险或待补充信息');
      if (await trx('la_decisions').where({ review_id: run.id }).first()) fail(409, 'DECISION_EXISTS', '最终结论已确认，不能覆盖');
      const row = (await trx('la_decisions').insert({ id: crypto.randomUUID(), review_id: run.id, version_id: run.version_id, decided_by: req.user.id, ...value }).returning('*'))[0];
      await trx('la_contracts').where({ id: c.id }).update({ legal_status: 'finalized', revision: trx.raw('revision + 1'), updated_at: trx.fn.now() }); await audit(trx, req.user, 'review.decision', row.id, { outcome: row.outcome, versionId: run.version_id }); return row;
    }); res.status(201).json(decision);
  }));
  r.post('/contracts/:id/archive', requireRole('legal'), wrap(async (req, res) => {
    const input = z.object({ manuallyReturned: z.literal(true), note: z.string().max(10000).default(''), signedVersionId: uuid.optional() }).parse(req.body);
    const result = await db.transaction(async trx => { const c = await accessible(trx, req.user, uuid.parse(req.params.id), true); assertRevision(c, revisionOf(req)); const decision = await trx('la_decisions').where({ review_id: c.current_review_id, version_id: c.current_version_id }).first(); if (!decision) fail(409, 'NO_CURRENT_DECISION', '当前版本尚无最终法务结论'); if (input.signedVersionId && !(await trx('la_versions').where({ id: input.signedVersionId, contract_id: c.id, kind: 'signed' }).first())) fail(400, 'INVALID_SIGNED_VERSION', '签署件不属于本合同'); const row = (await trx('la_archives').insert({ id: crypto.randomUUID(), contract_id: c.id, decision_id: decision.id, signed_version_id: input.signedVersionId || null, created_by: req.user.id, manually_returned: true, note: input.note }).returning('*'))[0]; await trx('la_contracts').where({ id: c.id }).update({ legal_status: 'archived', revision: trx.raw('revision + 1') }); await audit(trx, req.user, 'contract.archive', c.id, { decisionId: decision.id }); return row; });
    const c = await accessible(db, req.user, req.params.id); const v = await db('la_versions').where({ id: c.current_version_id }).first(); await storage.exportVersion(c, v, '人工确认稿'); if (result.signed_version_id) await storage.exportVersion(c, await db('la_versions').where({ id: result.signed_version_id }).first(), '已签署归档件'); res.status(201).json(result);
  }));
  r.get('/reviews/:id/report', wrap(async (req, res) => {
    const { run, c } = await readReview(db, req.user, req.params.id); const v = await db('la_versions').where({ id: run.version_id }).first();
    const findings = await db('la_findings').where({ review_id: run.id }); const decision = await db('la_decisions').where({ review_id: run.id }).first();
    await audit(db, req.user, 'report.download', run.id);
    const data = reportData(c, v, run, findings, decision), contract = { original_filename: v.filename, perspective: c.background.perspective };
    const format = req.query.format || 'html'; const name = `${c.number}_v${v.version_no}_${run.id}`;
    if (format === 'docx') { res.attachment(`${name}.docx`).send(legacy.generateDocxBuffer(contract, data)); }
    else if (format === 'pdf') { res.type('pdf').attachment(`${name}.pdf`); legacy.streamReviewReportPdf(res, contract, data); }
    else { const html = htmlReport(c, v, run, findings, decision); await storage.exportReport(c, run, html); res.type('html').attachment(`${name}.html`).send(html); }
  }));
  r.get('/rule-packs', requireRole('legal', 'publisher'), wrap(async (req, res) => res.json(await db('la_rule_versions').orderBy('pack_id').orderBy('version_no', 'desc'))));
  r.post('/rule-packs/:id/versions', requireRole('publisher'), wrap(async (req, res) => {
    const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/).parse(req.params.id); const row = await db.transaction(async trx => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`pack:${id}`]);
      const current = await trx('la_rule_versions').where({ pack_id: id, state: 'published' }).first();
      const p = await createDraft(trx, id, req.body, req.user.id);
      await trx('la_rule_versions').where({ id: p.id }).update({ base_version_id: current?.id || null }); p.base_version_id = current?.id || null;
      await audit(trx, req.user, 'rule.draft', p.id); return p;
    }); res.status(201).json(row);
  }));
  r.put('/rule-pack-versions/:id', requireRole('publisher'), wrap(async (req, res) => {
    const id = uuid.parse(req.params.id), body = packSchema.parse(req.body);
    if (new Set(body.rules.map(r => r.id)).size !== body.rules.length) fail(400, 'RULE_CONFLICT', '检查项编号重复');
    const result = await db.transaction(async trx => {
      const p = await trx('la_rule_versions').where({ id }).forUpdate().first(); if (!p) fail(404, 'RULE_NOT_FOUND', '规则不存在');
      assertRevision(p, revisionOf(req)); if (p.state !== 'draft') fail(409, 'RULE_STATE', '仅草稿可以编辑');
      const [row] = await trx('la_rule_versions').where({ id }).update({ name: body.name, scope: JSON.stringify(body.scope), rules: JSON.stringify(body.rules), knowledge: JSON.stringify(body.knowledge), revision: trx.raw('revision + 1'), updated_at: trx.fn.now() }).returning('*');
      await audit(trx, req.user, 'rule.edit', id, { sourceFeedbackId: p.source_feedback_id }); return row;
    }); res.json(result);
  }));
  for (const action of ['submit', 'publish', 'retire']) r.post(`/rule-pack-versions/:id/${action}`, requireRole('publisher'), wrap(async (req, res) => {
    await db.transaction(async trx => {
      const initial = await trx('la_rule_versions').where({ id: uuid.parse(req.params.id) }).first(); if (!initial) fail(404, 'RULE_NOT_FOUND', '规则版本不存在');
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))',[`pack:${initial.pack_id}`]);
      const p = await trx('la_rule_versions').where({id:initial.id}).forUpdate().first(); assertRevision(p, revisionOf(req));
      const expected = { submit: 'draft', publish: 'pending', retire: 'published' }[action]; if (p.state !== expected) fail(409, 'RULE_STATE', '规则状态不允许此操作');
      if (action === 'publish') {
        packSchema.parse(p);
        const current = await trx('la_rule_versions').where({ pack_id: p.pack_id, state: 'published' }).first();
        if ((current?.id || null) !== (p.base_version_id || null)) fail(409, 'RULE_BASE_CHANGED', '已有其他正式版本发布，请基于最新版本重新修改');
        await trx('la_rule_versions').where({ pack_id: p.pack_id, state: 'published' }).update({ state: 'retired', revision: trx.raw('revision + 1') });
      }
      await trx('la_rule_versions').where({ id: p.id }).update({ state: { submit: 'pending', publish: 'published', retire: 'retired' }[action], ...(action === 'publish' ? { published_by: req.user.id, published_at: trx.fn.now() } : {}), revision: trx.raw('revision + 1'), updated_at: trx.fn.now() });
      if (action === 'publish') {
        const linked = await trx('la_feedback').where({ draft_rule_version_id: p.id }).whereNot({ state: 'retired' });
        if (linked.length) {
          await trx('la_feedback').whereIn('id', linked.map(row => row.id)).update({ state: 'published', rule_version_id: p.id, revision: trx.raw('revision + 1'), updated_at: trx.fn.now() });
          for (const row of linked) await audit(trx, req.user, 'feedback.published', row.id, { ruleVersionId: p.id });
        }
      }
      await audit(trx, req.user, `rule.${action}`, p.id);
    }); res.json({ ok: true });
  }));
  r.get('/feedback-cases', requireRole('legal', 'publisher'), wrap(async (req, res) => res.json(await db('la_feedback').where(function () { if (!hasRole(req.user, 'publisher')) this.where({ created_by: req.user.id }); }).orderBy('created_at', 'desc').limit(200))));
  r.post('/feedback-cases', requireRole('legal', 'publisher'), wrap(async (req, res) => {
    const value = z.object({ reviewId: uuid.optional(), findingId: uuid.optional(), kind: z.enum(['rule', 'false_positive', 'false_negative', 'classification', 'normal_expression']), content: z.string().trim().min(1).max(20000) }).parse(req.body);
    if (value.reviewId) await readReview(db, req.user, value.reviewId);
    if (value.findingId && (!value.reviewId || !(await db('la_findings').where({ id: value.findingId, review_id: value.reviewId }).first()))) fail(400, 'INVALID_FINDING', '反馈检查项与预审不一致');
    const row = (await db('la_feedback').insert({ id: crypto.randomUUID(), created_by: req.user.id, review_id: value.reviewId, finding_id: value.findingId, kind: value.kind, content: value.content }).returning('*'))[0]; await audit(db, req.user, 'feedback.create', row.id); res.status(201).json(row);
  }));
  r.get('/evaluation-cases', requireRole('publisher'), wrap(async (req, res) => res.json(await db('la_evaluation_cases').select('id', 'name', 'split', 'expected', 'created_at'))));
  r.post('/evaluation-cases', requireRole('publisher'), wrap(async (req, res) => {
    const value = z.object({ name: z.string().min(1), split: z.enum(['development', 'holdout']), document: z.object({ blocks: z.array(z.object({ id: z.string(), text: z.string().min(1) })).min(1) }), expected: z.object({ typeId: z.string(), tags: z.array(z.string()).default([]), highRiskRuleIds: z.array(z.string()).default([]), riskRuleIds: z.array(z.string()).default([]), background: backgroundSchema.optional() }) }).parse(req.body);
    const row = (await db('la_evaluation_cases').insert({ id: crypto.randomUUID(), name: value.name, split: value.split, document: JSON.stringify(value.document), expected: JSON.stringify(value.expected), created_by: req.user.id }).returning('*'))[0]; res.status(201).json(row);
  }));
  r.post('/evaluations', requireRole('publisher'), wrap(async (req, res) => {
    const value = z.object({ adapters: z.array(z.enum(['llm', 'jev'])).min(1), split: z.enum(['development', 'holdout']), includeReview: z.boolean().default(true), draftRuleVersionId: uuid.optional() }).parse(req.body); const id = crypto.randomUUID();
    if (value.draftRuleVersionId) {
      if (value.split !== 'development') fail(400, 'DRAFT_DEVELOPMENT_ONLY', '规则草稿只可用于规则调试集');
      const draft = await db('la_rule_versions').where({ id: value.draftRuleVersionId, state: 'draft' }).first(); if (!draft) fail(409, 'DRAFT_REQUIRED', '请选择可用的规则草稿');
      const published = await db('la_rule_versions').where({ state: 'published' }).whereNot({ pack_id: draft.pack_id });
      value.ruleVersions = [...published, { ...draft, state: 'published' }]; value.draftRevision = draft.revision;
    }
    await db.transaction(async trx => { await trx('la_evaluations').insert({ id, config: JSON.stringify(value), created_by: req.user.id }); await trx('la_outbox').insert({ id: crypto.randomUUID(), queue: 'evaluation', payload: JSON.stringify({ evaluationId: id }) }); }); res.status(202).json({ id });
  }));
  r.get('/evaluations', requireRole('publisher'), wrap(async (req, res) => res.json(await db('la_evaluations').orderBy('created_at', 'desc').limit(100))));
  r.get('/settings', requireRole('admin'), wrap(async (req, res) => {
    res.set('Cache-Control','no-store').json(await settingsService.publicSettings(db));
  }));
  r.put('/settings/model', requireRole('admin'), wrap(async (req, res) => {
    const candidate = await settingsService.modelCandidate(db,req.body);
    if(!candidate.key)fail(400,'MODEL_KEY_REQUIRED','请填写 API 密钥；无鉴权的本机服务可填写 local');
    await settingsService.updateSetting(db,'model',req.body.expectedUpdatedAt,()=>({baseUrl:candidate.baseUrl,name:candidate.name,encryptedKey:settingsService.encrypt(candidate.key)}));
    await audit(db, req.user, 'settings.model', 'model', { host: new URL(candidate.baseUrl).hostname, name: candidate.name }); res.json({ ok: true });
  }));
  r.post('/settings/model/test', requireRole('admin'), wrap(async (req,res)=>{
    const candidate=await settingsService.modelCandidate(db,req.body),check=await settingsService.probeModel(candidate);
    await settingsService.saveModelCheck(db,candidate,check);await audit(db,req.user,'settings.model.test','model',{status:check.status});res.json(check);
  }));
  r.post('/settings/model/models', requireRole('admin'), wrap(async (req,res)=>res.json(await settingsService.probeModel(await settingsService.modelCandidate(db,req.body),{list:true}))));
  r.post('/settings/diagnostics', requireRole('admin'), wrap(async (req,res)=>res.json({checks:await settingsService.serviceDiagnostics(db)})));
  r.put('/settings/dingtalk-connection',requireRole('admin'),wrap(async(req,res)=>{
    const candidate=await settingsService.dingCandidate(db,req.body);
    await settingsService.updateSetting(db,'dingtalk_connection',req.body.expectedUpdatedAt,()=>({enabled:candidate.enabled,clientId:candidate.clientId,encryptedSecret:candidate.secret?settingsService.encrypt(candidate.secret):null}));
    await audit(db,req.user,'settings.dingtalk.connection','dingtalk',{enabled:candidate.enabled});res.json({ok:true});
  }));
  r.put('/settings/archive-root', requireRole('admin'), wrap(async (req, res) => {
    const candidate = await settingsService.archiveCandidate(req.body);
    const saved = await settingsService.updateSetting(db, 'contract_archive', req.body.expectedUpdatedAt, () => candidate);
    await audit(db, req.user, 'settings.archive_root', 'contract_archive', { enabled: candidate.enabled });
    res.json({ ok: true, archive: { ...candidate, updatedAt: new Date(saved.updated_at).toISOString() } });
  }));
  r.post('/settings/dingtalk/test',requireRole('admin'),wrap(async(req,res)=>res.json(await settingsService.probeDing(await settingsService.dingCandidate(db,req.body)))));
  r.get('/users', requireRole('admin'), wrap(async (req, res) => res.json((await db('la_users')).map(publicUser))));
  r.post('/users', requireRole('admin'), wrap(async (req, res) => {
    const v = z.object({ username: z.string().regex(/^[a-zA-Z0-9_.-]{3,64}$/), password: z.string().min(12).max(200), displayName: z.string().min(1).max(100), department: z.string().max(100).default(''), active: z.boolean().default(true), roles: z.array(z.enum(roles)).optional() }).parse(req.body);
    let row; try { row = (await db('la_users').insert({ id: crypto.randomUUID(), username: v.username, display_name: v.displayName, password_hash: await hashPassword(v.password), department: v.department, active: v.active, roles: JSON.stringify(['admin']) }).returning('*'))[0]; } catch (error) { if (error.code === '23505') fail(409,'USERNAME_EXISTS','该登录账号已存在，请换一个账号名称'); throw error; } await audit(db, req.user, 'user.create', row.id); res.status(201).json(publicUser(row));
  }));
  r.get('/operations', requireRole('admin'), wrap(async (req, res) => {
    const jobs = await db('la_reviews').select('id', 'status', 'stage', 'progress', 'error_code', 'error_message', 'created_at', 'updated_at').orderBy('created_at', 'desc').limit(100);
    const events = await db('la_integration_events').select('id', 'event_type', 'status', 'error', 'summary', 'created_at').orderBy('created_at', 'desc').limit(100);
    const pending = await db('la_outbox').whereNull('sent_at').count('id as count').first(); const backup = (await db('la_settings').where({ key: 'backup' }).first())?.value || {}; res.json({ jobs, events, pendingOutbox: Number(pending.count), backup });
  }));
  r.patch('/users/:id', requireRole('admin'), wrap(async (req, res) => {
    const value = z.object({ displayName: z.string().min(1).max(100), department: z.string().max(100), roles: z.array(z.enum(roles)).optional(), active: z.boolean(), password: z.string().min(12).max(200).optional() }).parse(req.body);
    await db.transaction(async trx => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['users']);
      const user = await trx('la_users').where({ id: uuid.parse(req.params.id) }).forUpdate().first(); if (!user) fail(404, 'USER_NOT_FOUND', '用户不存在'); assertRevision(user, revisionOf(req));
      if (user.roles.includes('admin') && !value.active) { const others = await trx('la_users').where({ active: true }).whereNot({ id: user.id }); if (!others.some(u => u.roles.includes('admin'))) fail(409, 'LAST_ADMIN', '不能停用最后一位管理员'); }
      await trx('la_users').where({ id: user.id }).update({ display_name: value.displayName, department: value.department, roles: JSON.stringify(['admin']), active: value.active, ...(value.password ? { password_hash: await hashPassword(value.password) } : {}), revision: trx.raw('revision + 1'), updated_at: trx.fn.now() });
      if (value.password || !value.active) await trx('la_sessions').whereRaw("sess->>'userId' = ?", [user.id]).delete();
      await audit(trx, req.user, 'user.update', user.id, { roles: ['admin'], active: value.active });
    }); res.json({ ok: true });
  }));
  r.patch('/feedback-cases/:id', requireRole('publisher'), wrap(async (req, res) => {
    const input = z.object({ state: z.enum(['pending', 'published', 'retired']), ruleVersionId: uuid.optional() }).parse(req.body);
    await db.transaction(async trx => { const row = await trx('la_feedback').where({ id: uuid.parse(req.params.id) }).forUpdate().first(); if (!row) fail(404, 'FEEDBACK_NOT_FOUND', '反馈不存在');
      assertRevision(row, revisionOf(req));
      if (!(row.state === 'candidate' && input.state === 'pending' || row.state === 'pending' && input.state === 'published' || row.state !== 'retired' && input.state === 'retired')) fail(409, 'FEEDBACK_STATE', '反馈状态不允许此操作');
      if (input.state === 'published' && !(input.ruleVersionId && await trx('la_rule_versions').where({ id: input.ruleVersionId, state: 'published' }).first())) fail(400, 'PUBLISHED_RULE_REQUIRED', '请关联已审核发布的正式规则版本');
      await trx('la_feedback').where({ id: row.id }).update({ state: input.state, rule_version_id: input.ruleVersionId || row.rule_version_id, revision: trx.raw('revision + 1'), updated_at: trx.fn.now() }); await audit(trx, req.user, 'feedback.' + input.state, row.id);
    }); res.json({ ok: true });
  }));
  r.post('/operations/:kind/:id/retry', requireRole('admin'), wrap(async (req, res) => {
    await db.transaction(async trx => {
      const id = uuid.parse(req.params.id), isReview = req.params.kind === 'reviews'; if (!isReview && req.params.kind !== 'events') fail(404, 'NOT_FOUND', '任务类型不存在');
      const table = isReview ? 'la_reviews' : 'la_integration_events'; const row = await trx(table).where({ id }).forUpdate().first();
      if (!row || !(isReview ? ['failed', 'waiting_input', 'finalizing'] : ['waiting_confirmation']).includes(row.status)) fail(409, 'RETRY_STATE', '当前状态不能重试'); if (isReview && ['MODEL_SNAPSHOT_CHANGED', 'MODEL_SNAPSHOT_MISSING'].includes(row.error_code)) fail(409, row.error_code, '模型配置已变化或缺少快照，请创建新的预审任务');
      await trx(table).where({ id }).update({ status: isReview ? 'queued' : 'received', updated_at: trx.fn.now() });
      const queue = isReview ? 'review' : row.event_type === 'reconciliation' ? 'integration-reconcile' : 'integration-live';
      await trx('la_outbox').insert({ id: crypto.randomUUID(), queue, payload: JSON.stringify(isReview ? { reviewId: id } : { eventId: id }) }); await audit(trx, req.user, 'operations.retry', id);
    }); res.status(202).json({ ok: true });
  }));
  r.get('/audit-events', requireRole('admin'), wrap(async (req, res) => res.json(await db('la_audit').orderBy('id', 'desc').limit(200))));
  r.get('/reviewers', requireRole('legal'), wrap(async (req, res) => res.json((await db('la_users').where({active:true})).map(u=>({id:u.id,displayName:u.display_name,department:u.department})))));
  r.put('/contracts/:id/assignment', requireRole('legal'), wrap(async (req,res)=>{
    const reviewerId=z.string().uuid().nullable().parse(req.body.reviewerId);
    await db.transaction(async trx=>{const c=await accessible(trx,req.user,uuid.parse(req.params.id),true);assertRevision(c,revisionOf(req));if(reviewerId){const user=await trx('la_users').where({id:reviewerId,active:true}).first();if(!hasRole(user,'legal'))fail(400,'ADMIN_REVIEWER_REQUIRED','只能分配给有效管理员账号');}await trx('la_contracts').where({id:c.id}).update({reviewer_id:reviewerId,revision:trx.raw('revision + 1')});await audit(trx,req.user,'contract.assign',c.id,{reviewerId});});res.json({ok:true});
  }));
  return r;
}
module.exports = { router, readReview, publicVersion };
