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
const { createDraft, packSchema, catalogWithAvailability, matchRules } = require('./rules');
const settingsService = require('./settings');
const storage = require('./storage');
const { htmlReport, reportData, legacy } = require('./reports');
const { annotatedContract } = require('./annotated-contract');
const { buildAnnotatedDocument } = require('./annotated-versions');
const { publicConversion } = require('./conversion');
const { groupFindings } = require('./finding-groups');


// Browsers send multipart filenames as UTF-8, including names without filename*.
const upload = multer({ storage: multer.memoryStorage(), defParamCharset: 'utf8', limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 20 } });
const uuid = z.string().uuid();
const backgroundSchema = z.object({ ourEntity: z.string().trim().max(200).default(''), ourSide: z.enum(['', 'party_a', 'party_b', 'other']).optional(), supplementIds: z.array(uuid).max(100).optional(), perspective: z.string().trim().max(200).default(''), purpose: z.string().trim().max(3000).default('') }).transform(value => ({ ...value, ourEntity: value.ourEntity || (value.ourSide === 'party_a' ? '合同所列甲方' : value.ourSide === 'party_b' ? '合同所列乙方' : '') }));
const revisionOf = req => z.coerce.number().int().positive().parse(req.body.revision);
const jsonField = (value, fallback = {}) => { if (!value) return fallback; try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { fail(400, 'INVALID_JSON', '表单 JSON 字段无效'); } };
const publicVersion = v => { const { storage_key, ...result } = v; return { ...result, conversion: publicConversion(v.conversion) }; };
async function readReview(db, user, id) { uuid.parse(id); const run = await db('la_reviews').where({ id }).first(); if (!run) fail(404, 'REVIEW_NOT_FOUND', '预审任务不存在'); const c = await accessible(db, user, run.contract_id); for (const contractId of run.snapshot?.revisionBaseline?.accessContractIds || []) await accessible(db, user, contractId); return { run, c }; }
function assertCurrent(c, run) { if (c.current_review_id !== run.id || c.current_version_id !== run.version_id) fail(409, 'STALE_REVIEW', '该任务已不是当前版本，请在最新预审中处理'); }
async function assertReviewWritable(trx, c, run) {
  if (run.engine !== 'harness-v1') fail(410, 'REVIEW_ENGINE_RETIRED', '历史结果只供查询与导出，请创建新的 Agent 审查后处理');
  await require('./joint-intake').assertCurrent(trx, c, run.snapshot);
  if (c.legal_status === 'returned' || await trx('la_returns').where({ review_id: run.id, version_id: run.version_id }).first()) fail(409, 'CONTRACT_RETURNED', '该预审已退回，请上传修改版本或创建新的预审任务');
}
async function archiveConfirmedVersion(db, user, contractId) {
  try {
    const archiveConfig = await settingsService.archiveConfig(db);
    if (!archiveConfig.enabled) return { status: 'not_configured' };
    const c = await accessible(db, user, contractId);
    const v = await db('la_versions').where({ id: c.current_version_id }).first();
    const file = await storage.archiveClassifiedVersion(c, v, archiveConfig.root);
    await audit(db, user, 'contract.classification_archive', c.id, { path: file, typeId: c.classification?.typeId });
    return { status: 'archived', path: file };
  } catch (error) {
    await audit(db, user, 'contract.classification_archive_failed', contractId, { code: error.code || 'ARCHIVE_FAILED' });
    return { status: 'failed', message: '分类已确认，但附件自动归档失败，请检查归档目录权限' };
  }
}
function router(db) {
  const r = express.Router();
  require('./agent/routes').mount(r, db);
  r.use(require('./agent/routes').retireLegacy);
  const { mountPreanalysisRoutes, publicPreanalysis } = require('./preanalysis');
  mountPreanalysisRoutes(r, db, { archiveConfirmedVersion });
  require('./feedback').mountFeedbackRoutes(r, db);
  require('./classification-guidance').mountGuidanceRoutes(r, db);
  require('./skills').mountSkillRoutes(r, db);
  require('./learning').mountLearningRoutes(r, db);
  require('./joint-intake').mountRoutes(r, db);
  require('./auto-review-batch').mountRoutes(r, db);
  require('./word-conversions').mountRoutes(r, db);
  r.post('/dingtalk/intakes/:id/documents', requireRole('legal'), upload.single('file'), wrap(async (req, res) => {
    const result = await db.transaction(async trx => {
      const joint = require('./joint-intake'), intake = await joint.readIntake(trx, req.user, req.params.id, true); assertRevision(intake, revisionOf(req)); storage.validateUpload(req.file);
      const id = crypto.randomUUID(), container = await accessible(trx, req.user, intake.container_id), actor = await trx('la_users').where({ id: intake.recipient_id }).first();
      await trx('la_intake_documents').insert({ id, intake_id: intake.id, file_id: 'manual:' + id, filename: storage.safeName(req.file.originalname), field: '人工补充', status: 'collected' });
      const value = await createContract(trx, actor, req.file, { source: 'dingtalk', guidedReview: true, versionActorId: req.user.id, reviewerId: container.reviewer_id, sourceData: { processInstanceId: intake.instance_id, clientId: intake.client_id, jointIntakeId: intake.id, jointDocumentId: id, jointHidden: true } });
      await trx('la_intake_documents').where({ id }).update({ contract_id: value.contract.id }); await joint.scheduleAnalysis(trx, intake, req.user.id);
      await audit(trx, req.user, 'joint_intake.add_document', id, { intakeId: intake.id, versionId: value.version.id }); return { documentId: id, versionId: value.version.id };
    }); res.status(201).json(result);
  }));
  r.post('/dingtalk/intakes/:id/documents/:documentId/file', requireRole('legal'), upload.single('file'), wrap(async (req, res) => {
    const result = await db.transaction(async trx => {
      const joint = require('./joint-intake'), intake = await joint.readIntake(trx, req.user, req.params.id, true); assertRevision(intake, revisionOf(req));
      const doc = await trx('la_intake_documents').where({ id: uuid.parse(req.params.documentId), intake_id: intake.id }).first();
      if (!doc) fail(404, 'DOCUMENT_NOT_FOUND', '附件不存在');
      storage.validateUpload(req.file);
      await trx('la_intake_documents').where({ id: doc.id }).update({ status: 'collected', present: true, error: null });
      let value;
      if (doc.contract_id) value = await addVersion(trx, await accessible(trx, req.user, doc.contract_id, true), req.file, req.user.id);
      else {
        const container = await accessible(trx, req.user, intake.container_id), actor = await trx('la_users').where({ id: intake.recipient_id }).first();
        value = await createContract(trx, actor, req.file, { source: 'dingtalk', guidedReview: true, versionActorId: req.user.id, reviewerId: container.reviewer_id, sourceData: { processInstanceId: intake.instance_id, clientId: intake.client_id, jointIntakeId: intake.id, jointDocumentId: doc.id, jointHidden: true } });
        await trx('la_intake_documents').where({ id: doc.id }).update({ contract_id: value.contract.id });
      }
      if (intake.status !== 'confirmed') await joint.scheduleAnalysis(trx, intake, req.user.id);
      await audit(trx, req.user, 'joint_intake.replace', doc.id, { versionId: value.version.id }); return { versionId: value.version.id };
    }); res.status(201).json(result);
  }));
  r.get('/catalog', wrap(async (req, res) => res.json({ categories: await catalogWithAvailability(db), tags, version: catalogVersion })));
  r.get('/contracts', wrap(async (req, res) => {
    const paginated = req.query.page !== undefined, page = paginated ? z.coerce.number().int().min(1).max(1000000).parse(req.query.page) : 1;
    const q = db('la_contracts');
    if (req.query.view !== 'all') q.whereRaw("COALESCE(source_data->>'jointHidden', 'false') <> 'true'");
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
    const analyses = rows.length ? await db('la_preanalyses').whereIn('id', rows.map(c => c.current_preanalysis_id).filter(Boolean)).select('id', 'status', 'stage', 'progress', 'version_id', 'error_code', 'error_message') : [];
    const attachmentCounts = rows.length ? await db('la_attachments').select('contract_id').count('* as n').whereIn('contract_id', rows.map(c => c.id)).groupBy('contract_id') : [];
    const countByContract = new Map(attachmentCounts.map(row => [row.contract_id, Number(row.n)]));
    const intakeIds = [...new Set(rows.map(c => c.source_data?.jointIntakeId).filter(Boolean))];
    const intakes = intakeIds.length ? await db('la_dingtalk_intakes').whereIn('id', intakeIds).select('id', 'status') : [];
    const items = rows.map(c => ({
      ...c,
      review: runs.find(x => x.id === c.current_review_id) || null,
      preanalysis: analyses.find(x => x.id === c.current_preanalysis_id) || null,
      approvalTitle: c.source_data?.title || c.title,
      receivedAt: c.created_at,
      intakeReason: c.source_data?.reconciliationReason || (c.intake_mode === 'reconciliation' ? '接入后历史审批补查' : ''),
      attachmentCount: countByContract.get(c.id) || 0,
      entryType: c.source_data?.jointContainer ? 'dingtalk_intake' : 'contract', intakeId: c.source_data?.jointIntakeId || null,
      intakeStatus: intakes.find(i => i.id === c.source_data?.jointIntakeId)?.status || null,
    }));
    res.json(paginated ? { items, total, page, pageSize: 50 } : items);
  }));
  r.post('/contracts/upload', requireRole('business', 'legal'), upload.single('file'), wrap(async (req, res) => {
    if (!req.file) fail(400, 'FILE_REQUIRED', '请选择合同文件');
    // All intake channels enqueue the Agent engine; optional legacy metadata is historical only.
    const guidedReview = false;
    const background = backgroundSchema.parse(jsonField(req.body.background));
    let classification;
    if (req.body.classification) {
      const value = z.object({ typeId: z.string(), tags: z.array(z.enum(tags)).default([]), perspectiveConfirmed: z.boolean().default(false) }).parse(jsonField(req.body.classification));
      if (!findType(value.typeId)) fail(400, 'UNKNOWN_TYPE', '请选择目录内合同类型');
      if (value.perspectiveConfirmed && !hasRole(req.user, 'legal')) fail(403, 'FORBIDDEN', '分类与立场由法务确认');
      classification = { ...value, perspectiveConfirmed: !guidedReview && value.perspectiveConfirmed, confirmed: !guidedReview && value.perspectiveConfirmed, selectedBy: req.user.id, selectedAt: new Date().toISOString(), ...(!guidedReview && value.perspectiveConfirmed ? { confirmedBy: req.user.id, confirmedAt: new Date().toISOString() } : {}) };
    }
    const result = await db.transaction(async trx => {
      const value = await createContract(trx, req.user, req.file, { title: req.body.title, background, classification, guidedReview });
      await audit(trx, req.user, 'contract.upload', value.contract.id, { typeId: classification?.typeId, classificationConfirmed: !!classification?.confirmed });
      if (classification?.confirmed) await audit(trx, req.user, 'classification.confirm', value.contract.id, { typeId: classification.typeId, atUpload: true });
      return value;
    });
    const archive = classification?.confirmed ? await archiveConfirmedVersion(db, req.user, result.contract.id) : { status: 'not_requested' };
    res.status(201).json({ ...result, version: publicVersion(result.version), archive });
  }));
  r.get('/contracts/:id', wrap(async (req, res) => {
    uuid.parse(req.params.id); const c = await accessible(db, req.user, req.params.id);
    const versions = await db('la_versions').where({ contract_id: c.id }).orderBy('version_no', 'desc');
    const reviews = await db('la_reviews').where({ contract_id: c.id }).orderBy('created_at', 'desc');
    const decisions = reviews.length ? await db('la_decisions').whereIn('review_id', reviews.map(r => r.id)) : [];
    await audit(db, req.user, 'contract.view', c.id);
    const preanalysis = c.current_preanalysis_id ? publicPreanalysis(await db('la_preanalyses').where({ id: c.current_preanalysis_id }).first()) : null;
    const jointIntake = c.source_data?.jointIntakeId ? await require('./joint-intake').detail(db, req.user, c.source_data.jointIntakeId) : null;
    const jointGroup = jointIntake?.groups.find(g => g.id === c.source_data.jointGroupId) || null;
    const autoReview = await db('la_auto_review_batch_documents as d').join('la_auto_review_batches as b', 'b.id', 'd.batch_id').where('d.contract_id', c.id).orderBy('b.created_at', 'desc').select('b.id').first();
    const members = jointGroup ? new Set([jointGroup.mainDocumentId, ...jointGroup.materials.map(m => m.documentId)]) : new Set();
    res.json({ ...c, autoReviewBatchId: autoReview?.id || jointIntake?.autoReviewBatchId || null, preanalysis, versions: versions.map(publicVersion), reviews, decisions, jointGroup, jointIntake: jointIntake ? { id: jointIntake.id, title: jointIntake.title, status: jointIntake.status } : null, jointDocuments: jointIntake?.documents.filter(d => members.has(d.id)) || [], returns: reviews.length ? await db('la_returns').whereIn('review_id', reviews.map(r => r.id)).orderBy('created_at','desc') : [], archives: await db('la_archives').where({ contract_id: c.id }) });
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
    const row = await db.transaction(async trx => { const c = await accessible(trx, req.user, uuid.parse(req.params.id), true); assertRevision(c, revisionOf(req)); await trx('la_contracts').where({ id: c.id }).update({ background: JSON.stringify(background), revision: trx.raw('revision + 1') }); const id = await enqueueReview(trx, { ...c, background }, req.user.id); await audit(trx, req.user, 'contract.background', c.id); return { reviewId: id }; }); res.json(row);
  }));
  r.post('/contracts/:id/versions', requireRole('business', 'legal'), upload.single('file'), wrap(async (req, res) => {
    const result = await db.transaction(async trx => { const c = await accessible(trx, req.user, uuid.parse(req.params.id), true); assertRevision(c, revisionOf(req)); const kind = z.enum(['signed', 'supplement', 'contract']).default('contract').parse(req.body.kind); const value = await addVersion(trx, c, req.file, req.user.id, 'upload', kind); await audit(trx, req.user, 'contract.version', c.id, { versionId: value.version.id, kind }); return value; });
    res.status(result.duplicate ? 200 : 201).json({ ...result, version: publicVersion(result.version) });
  }));
  r.post('/versions/:id/conversion', requireRole('business', 'legal'), wrap(async (req, res) => {
    await db.transaction(async trx => {
      const version = await trx('la_versions').where({ id: uuid.parse(req.params.id) }).forUpdate().first();
      if (!version) fail(404, 'FILE_NOT_FOUND', '文件不存在');
      await accessible(trx, req.user, version.contract_id, true);
      if (!require('./file-formats').needsConversion(version.filename)) fail(400, 'CONVERSION_NOT_REQUIRED', '该文件无需转换');
      if (version.kind === 'contract') fail(400, 'REVIEW_REQUIRED', '请重新发起预审，自动重试文件转换');
      if (version.conversion?.status !== 'failed') fail(409, 'CONVERSION_STATE', '文件已转换或正在处理');
      await trx('la_versions').where({ id: version.id }).update({ conversion: JSON.stringify({ status: 'pending' }) });
      await trx('la_outbox').insert({ id: crypto.randomUUID(), queue: 'conversion', payload: JSON.stringify({ versionId: version.id }) });
      await audit(trx, req.user, 'document.conversion_retry', version.contract_id, { versionId: version.id });
    });
    res.status(202).json({ ok: true });
  }));
  r.get('/versions/:id/editable-word', wrap(async (req, res) => {
    const version = await db('la_versions').where({ id: uuid.parse(req.params.id) }).first();
    if (!version) fail(404, 'FILE_NOT_FOUND', '文件不存在');
    await accessible(db, req.user, version.contract_id);
    if (!version.filename.toLowerCase().endsWith('.pdf')) fail(400, 'PDF_ONLY', '文字重建仅适用于 PDF');
    if (!version.parsed?.blocks?.length) fail(409, 'TEXT_NOT_READY', 'PDF 正文尚未识别完成，请等待解析；扫描件需要配置 OCR');
    const buffer = require('./editable-word').editableWord(version);
    await audit(db, req.user, 'document.editable_word_download', version.contract_id, { versionId: version.id, sha256: version.sha256, mode: 'text_reconstruction' });
    res.set('Cache-Control', 'private, no-store').type('application/vnd.openxmlformats-officedocument.wordprocessingml.document').attachment(`${storage.safeName(version.filename).replace(/\.[^.]+$/, '')}_v${version.version_no}_PDF文字重建.docx`).send(buffer);
  }));
  r.get('/reviews/:id', wrap(async (req, res) => {
    const { run, c } = await readReview(db, req.user, req.params.id);
    const findings = await db('la_findings').where({ review_id: run.id }).orderBy('created_at').orderBy('id');
    let isCurrent = c.current_review_id === run.id && c.current_version_id === run.version_id, staleReason = '';
    if (isCurrent) try { await require('./joint-intake').assertCurrent(db, c, run.snapshot); } catch (e) { if (e.status !== 409) throw e; isCurrent = false; staleReason = e.message; }
    const documents = [];
    for (const entry of run.snapshot?.documents || run.snapshot?.jointGroup?.documents || []) documents.push({ ...entry, version: publicVersion(await require('./joint-intake').reviewDocument(db, req.user, run, entry.versionId)) });
    const decision = await db('la_decisions').where({ review_id: run.id }).first();
    if (decision) decision.withdrawal = await db('la_decision_withdrawals').where({ decision_id: decision.id }).first() || null;
    res.json({ ...run, isCurrent, staleReason, documents, findings, opinionGroups: groupFindings(findings), decision: decision || null, steps: await db('la_job_steps').where({ review_id: run.id }).orderBy('id') });
  }));
  r.put('/reviews/:id/findings/:findingId/disposition', requireRole('legal'), wrap(async (req, res) => {
    const input = z.object({ action: z.enum(['accept', 'reject', 'correct', 'needs_information', 'acknowledge']), reason: z.string().max(10000).default(''), suggestion: z.string().max(10000).optional(), severity: z.enum(['high', 'medium', 'low']).optional() }).parse(req.body);
    if ((input.action !== 'accept' && !input.reason.trim()) || (input.severity || input.suggestion !== undefined) && !input.reason.trim()) fail(400, 'REASON_REQUIRED', '驳回、修正或补充处理必须填写理由');
    await db.transaction(async trx => {
      const { run } = await readReview(trx, req.user, req.params.id); const c = await accessible(trx, req.user, run.contract_id, true); assertCurrent(c, run); await assertReviewWritable(trx, c, run);
      if (run.status !== 'completed' || await trx('la_decisions').where({ review_id: run.id }).first()) fail(409, 'REVIEW_LOCKED', '此预审尚未完成或已确认结论');
      const f = await trx('la_findings').where({ id: uuid.parse(req.params.findingId), review_id: run.id }).forUpdate().first(); if (!f) fail(404, 'FINDING_NOT_FOUND', '检查项不存在'); assertRevision(f, revisionOf(req));
      if (f.check_status === 'uncertain' && !input.reason.trim()) fail(400, 'REASON_REQUIRED', '确认不确定项必须填写明确的法务处理意见');
      let targetIds = [f.id];
      if (req.body.applyToDuplicates === true) {
        const all = await trx('la_findings').where({ review_id: run.id }).orderBy('id').forUpdate();
        targetIds = groupFindings(all).find(group => group.relatedFindings.some(item => item.id === f.id)).relatedFindings.map(item => item.id);
      }
      await trx('la_findings').whereIn('id', targetIds).update({ disposition: JSON.stringify({ ...input, actorId: req.user.id, at: new Date().toISOString() }), revision: trx.raw('revision + 1'), updated_at: trx.fn.now() });
      if (run.engine === 'harness-v1') await require('./agent/memory').record(trx, req.user, { contractId: c.id, reviewId: run.id, kind: 'finding_disposition', eventKey: `finding:${f.id}:${f.revision + 1}`, source: { findingId: f.id, title: f.title, originalEvidence: f.evidence, aiReason: f.reason, aiSuggestion: f.suggestion, legalAction: input, limitation: input.action === 'accept' ? '法务已明确采纳本意见，仍须保留本案适用条件。' : '以法务处理理由为准，不把被驳回的AI判断作为经验。' } });
      if (targetIds.length > 1) await audit(trx, req.user, 'finding.group_disposition', f.id, { action: input.action, findingIds: targetIds });
      await trx('la_contracts').where({ id: c.id }).update({ legal_status: 'in_review', revision: trx.raw('revision + 1') }); await audit(trx, req.user, 'finding.disposition', f.id, { action: input.action });
    }); res.json({ ok: true });
  }));
  r.post('/reviews/:id/findings', requireRole('legal'), wrap(async (req, res) => {
    const value = z.object({ title: z.string().min(1), reason: z.string().min(1), suggestion: z.string().default(''), severity: z.enum(['high', 'medium', 'low']), evidence: z.array(z.object({ versionId: uuid.optional(), blockId: z.string(), quote: z.string().min(1) })).default([]) }).parse(req.body);
    await db.transaction(async trx => {
      const { run } = await readReview(trx, req.user, req.params.id);
      const c = await accessible(trx, req.user, run.contract_id, true);
      assertCurrent(c, run); await assertReviewWritable(trx, c, run);
      if (run.status !== 'completed' || await trx('la_decisions').where({ review_id: run.id }).first()) fail(409, 'REVIEW_LOCKED', '任务尚未完成或已确认');
      value.evidence = await require('./joint-intake').verifyReviewEvidence(trx, req.user, run, value.evidence);
      const id = crypto.randomUUID();
      await trx('la_findings').insert({ id, review_id: run.id, rule_id: null, title: value.title, reason: value.reason, suggestion: value.suggestion, severity: value.severity, kind: value.evidence.length ? 'clause' : 'uncertain', check_status: 'fail', evidence: JSON.stringify(value.evidence), disposition: JSON.stringify({ action: 'accept', reason: value.reason, actorId: req.user.id, at: new Date().toISOString() }) });
      await require('./agent/memory').record(trx, req.user, { contractId: c.id, reviewId: run.id, kind: 'explicit_feedback', eventKey: 'manual-finding:' + id, source: { ...value, origin: '法务主动补充的意见' } });
      await trx('la_contracts').where({id:c.id}).update({revision:trx.raw('revision + 1'), legal_status:'in_review'});
      await audit(trx, req.user, 'finding.add', run.id);
    }); res.status(201).json({ ok: true });
  }));
  r.post('/reviews/:id/return', requireRole('legal'), wrap(async (req, res) => {
    const reason = z.string().trim().min(1).max(10000).parse(req.body.reason);
    await db.transaction(async trx => { const { run } = await readReview(trx, req.user, req.params.id); const c = await accessible(trx, req.user, run.contract_id, true); assertRevision(c, revisionOf(req)); assertCurrent(c, run); await assertReviewWritable(trx, c, run); if (await trx('la_decisions').where({ review_id: run.id }).first()) fail(409, 'DECISION_EXISTS', '已确认的结论不能退回覆盖，请创建新预审'); if (await trx('la_returns').where({ review_id: run.id, version_id: run.version_id }).first()) fail(409, 'CONTRACT_RETURNED', '该预审已经退回，请创建新的预审任务'); await trx('la_returns').insert({ id: crypto.randomUUID(), review_id: run.id, version_id: run.version_id, created_by: req.user.id, reason }); await trx('la_contracts').where({ id: c.id }).update({ legal_status: 'returned', revision: trx.raw('revision + 1') }); await audit(trx, req.user, 'review.return', c.id, { reason }); }); res.json({ ok: true });
  }));
  r.post('/reviews/:id/decision', requireRole('legal'), wrap(async (req, res) => {
    const value = z.object({ outcome: z.enum(['agree', 'conditional', 'disagree']), reason: z.string().max(10000).default(''), conditions: z.string().max(10000).default('') }).parse(req.body);
    if (value.outcome === 'conditional' && !value.conditions.trim() || value.outcome === 'disagree' && !value.reason.trim()) fail(400, 'DECISION_REASON', '附条件同意需填写条件，不同意需填写理由');
    const decision = await db.transaction(async trx => {
      const { run } = await readReview(trx, req.user, req.params.id); const c = await accessible(trx, req.user, run.contract_id, true); assertRevision(c, revisionOf(req)); assertCurrent(c, run); await assertReviewWritable(trx, c, run);
      if (run.snapshot.reviewMode === 'trial') fail(409, 'TRIAL_REVIEW_ONLY', '历史示例试审不能确认最终结论；请重新预审后复核确认，无需先发布规则包');
      if (c.legal_status === 'returned') fail(409, 'CONTRACT_RETURNED', '合同已退回，请等待新版本或重新发起预审');
      if (run.status !== 'completed' || !run.coverage.complete) fail(409, 'REVIEW_INCOMPLETE', 'AI 预审尚未完整完成');
      if (run.engine !== 'harness-v1' && (!c.classification?.confirmed || !c.classification.perspectiveConfirmed || c.classification.versionId !== run.version_id)) fail(409, 'CLASSIFICATION_UNCONFIRMED', '请确认当前版本分类及我方立场');
      const findings = await trx('la_findings').where({ review_id: run.id });
      if (run.engine !== 'harness-v1' && findings.some(f => f.disposition?.action === 'needs_information' || f.check_status !== 'pass' && !f.disposition)) fail(409, 'UNRESOLVED_FINDINGS', '仍有未处理风险或待补充信息');
      if (await trx('la_decisions').where({ review_id: run.id }).first()) fail(409, 'DECISION_EXISTS', '最终结论已确认，不能覆盖');
      const row = (await trx('la_decisions').insert({ id: crypto.randomUUID(), review_id: run.id, version_id: run.version_id, decided_by: req.user.id, materials_snapshot: run.snapshot.jointGroup ? JSON.stringify(run.snapshot.jointGroup) : run.engine === 'harness-v1' ? JSON.stringify({engine:run.engine,documents:run.snapshot.documents}) : null, ...value }).returning('*'))[0];
      if (run.engine === 'harness-v1') await require('./agent/memory').record(trx, req.user, { contractId: c.id, reviewId: run.id, kind: 'legal_decision', eventKey: 'decision:' + row.id, source: { outcome: row.outcome, reason: row.reason, conditions: row.conditions, limitation: '最终结论仅适用于本案，不自动代表采纳全部AI建议。' } });
      await trx('la_contracts').where({ id: c.id }).update({ legal_status: 'finalized', revision: trx.raw('revision + 1'), updated_at: trx.fn.now() }); await audit(trx, req.user, 'review.decision', row.id, { outcome: row.outcome, versionId: run.version_id }); return row;
    }); res.status(201).json(decision);
  }));
  r.post('/contracts/:id/archive', requireRole('legal'), wrap(async (req, res) => {
    const input = z.object({ manuallyReturned: z.literal(true), note: z.string().max(10000).default(''), signedVersionId: uuid.optional() }).parse(req.body);
    const result = await db.transaction(async trx => { const c = await accessible(trx, req.user, uuid.parse(req.params.id), true); assertRevision(c, revisionOf(req)); const decision = await trx('la_decisions').where({ review_id: c.current_review_id, version_id: c.current_version_id }).first(); if (!decision) fail(409, 'NO_CURRENT_DECISION', '当前版本尚无最终法务结论'); const run = await trx('la_reviews').where({ id: decision.review_id }).first(); await require('./joint-intake').assertCurrent(trx, c, run.snapshot); if (input.signedVersionId && !(await trx('la_versions').where({ id: input.signedVersionId, contract_id: c.id, kind: 'signed' }).first())) fail(400, 'INVALID_SIGNED_VERSION', '签署件不属于本合同'); const row = (await trx('la_archives').insert({ id: crypto.randomUUID(), contract_id: c.id, decision_id: decision.id, signed_version_id: input.signedVersionId || null, created_by: req.user.id, manually_returned: true, note: input.note }).returning('*'))[0]; await trx('la_contracts').where({ id: c.id }).update({ legal_status: 'archived', revision: trx.raw('revision + 1') }); await audit(trx, req.user, 'contract.archive', c.id, { decisionId: decision.id }); return row; });
    const c = await accessible(db, req.user, req.params.id); const v = await db('la_versions').where({ id: c.current_version_id }).first(); await storage.exportVersion(c, v, '人工确认稿'); if (result.signed_version_id) await storage.exportVersion(c, await db('la_versions').where({ id: result.signed_version_id }).first(), '已签署归档件'); res.status(201).json(result);
  }));
  r.get('/reviews/:id/final-contract', wrap(async (req, res) => {
    const { run } = await readReview(db, req.user, req.params.id);
    const decision = await db('la_decisions').where({ review_id: run.id, version_id: run.version_id }).first();
    if (decision && await db('la_decision_withdrawals').where({ decision_id: decision.id }).first()) fail(409, 'DECISION_WITHDRAWN', '该结论已撤回，须由法务重新复核确认，不能下载为确认稿');
    if (!decision || decision.outcome !== 'agree') fail(409, 'FINAL_NOT_APPROVED', '仅法务确认同意的版本可下载确认稿；附条件同意请先落实条件并上传修订稿重新确认');
    const version = await require('./joint-intake').reviewDocument(db, req.user, run, req.query.versionId ? uuid.parse(req.query.versionId) : decision.version_id);
    if (!version) fail(404, 'VERSION_NOT_FOUND', '结论绑定的文件版本不存在');
    const bytes = await storage.read(version.storage_key);
    if (storage.sha256(bytes) !== version.sha256) fail(409, 'FILE_INTEGRITY', '文件校验未通过，请联系管理员');
    await audit(db, req.user, 'contract.final_download', run.id, { decisionId: decision.id, versionId: version.id, sha256: version.sha256 });
    res.set('Cache-Control', 'no-store').type(version.media_type).attachment(`v${version.version_no}_法务确认稿_${storage.safeName(version.filename)}`).send(bytes);
  }));
  r.get('/reviews/:id/annotated-contract', wrap(async (req, res) => {
    const { run } = await readReview(db, req.user, req.params.id);
    const mode = z.enum(['comments', 'color']).default('comments').parse(req.query.mode);
    if (!req.query.versionId) {
      const prepared = await buildAnnotatedDocument(db, req.user, run.id, mode);
      await audit(db, req.user, 'contract.annotations_download', run.id, { versionId: prepared.source.version.id, mode, located: prepared.result.located, unlocated: prepared.result.unlocated });
      res.set('Cache-Control', 'no-store').attachment(`${storage.safeName(prepared.source.filename).replace(/\.docx$/i, '')}_v${prepared.source.version.version_no}_${mode === 'color' ? '彩色建议稿' : '批注版'}.docx`).send(prepared.result.buffer);
      return;
    }
    const version = await require('./joint-intake').reviewDocument(db, req.user, run, req.query.versionId ? uuid.parse(req.query.versionId) : run.version_id);
    if (!version) fail(404, 'VERSION_NOT_FOUND', '预审对应的原文版本不存在');
    const findings = await db('la_findings').where({ review_id: run.id }).orderBy('created_at').orderBy('id');
    const convertedWord = version.conversion?.artifacts?.docx;
    const annotationSource = convertedWord ? { ...version, filename: version.filename.replace(/\.[^.]+$/, '.docx') } : version;
    const scoped = run.snapshot.jointGroup ? require('./joint-review').evidenceForFile(findings, version.id, run.version_id) : findings;
    const result = annotatedContract(await storage.read(convertedWord?.storage_key || version.storage_key), annotationSource, run, scoped, mode);
    await audit(db, req.user, 'contract.annotations_download', run.id, { versionId: version.id, mode, located: result.located, unlocated: result.unlocated });
    res.set('Cache-Control', 'no-store').attachment(`${storage.safeName(version.filename).replace(/\.[^.]+$/, '')}_v${version.version_no}_${mode === 'color' ? '彩色建议稿' : '批注版'}.docx`).send(result.buffer);
  }));
  r.get('/reviews/:id/report', wrap(async (req, res) => {
    const { run, c } = await readReview(db, req.user, req.params.id); const v = await db('la_versions').where({ id: run.version_id }).first();
    const findings = await db('la_findings').where({ review_id: run.id }); const decision = await db('la_decisions').where({ review_id: run.id }).first();
    if (decision) decision.withdrawal = await db('la_decision_withdrawals').where({ decision_id: decision.id }).first() || null;
    await audit(db, req.user, 'report.download', run.id);
    const data = reportData(c, v, run, findings, decision), contract = { original_filename: v.filename, perspective: c.background.perspective };
    const format = req.query.format || 'html'; const name = `${c.number}_v${v.version_no}_${run.id}`;
    if (format === 'docx') { res.attachment(`${name}.docx`).send(legacy.generateDocxBuffer(contract, data)); }
    else if (format === 'pdf') { res.type('pdf').attachment(`${name}.pdf`); legacy.streamReviewReportPdf(res, contract, data); }
    else { const html = htmlReport(c, v, run, findings, decision); await storage.exportReport(c, run, html); res.type('html').attachment(`${name}.html`).send(html); }
  }));
  r.get('/rule-packs', requireRole('legal', 'publisher'), wrap(async (req, res) => {const rows=await db('la_rule_versions').orderBy('pack_id').orderBy('version_no','desc');const {publicVersion,itemChanges}=require('./knowledge-catalog');res.json(rows.map(p=>({...publicVersion(p,rows),changes:itemChanges(rows.find(x=>x.id===p.base_version_id)?.rules,p.rules)})));}));
  r.get('/feedback-cases', requireRole('legal', 'publisher'), wrap(async (req, res) => res.json(await db('la_feedback').where(function () { if (!hasRole(req.user, 'publisher')) this.where({ created_by: req.user.id }); }).orderBy('created_at', 'desc').limit(200))));
  r.get('/evaluation-cases', requireRole('publisher'), wrap(async (req, res) => res.json(await db('la_evaluation_cases').select('id', 'name', 'split', 'expected', 'created_at'))));
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
