const express = require('express');
const multer = require('multer');
const { z } = require('zod');
const { accessible, requireRole, audit } = require('./auth');
const { wrap, fail } = require('./errors');
const storage = require('./storage');
const { editorDocument } = require('./office-document');
const { parseDocx } = require('./parser');
const { addVersion } = require('./contracts');
const learning = require('./review-learning');

const uuid = z.string().uuid();
const upload = multer({ storage: multer.memoryStorage(), defParamCharset: 'utf8', limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 4, fieldSize: 200000 } });
const actionSchema = z.array(z.object({ action: z.enum(['accept', 'reject']), insertedText: z.string().max(20000).default(''), deletedText: z.string().max(20000).default('') })).max(300);

async function openedDocument(db, user, contract, version, reviewId) {
  const converted = version.conversion?.artifacts?.docx;
  if (!version.filename.toLowerCase().endsWith('.docx') && !converted) fail(422, 'DOCX_ONLY', '请先将合同转换为 DOCX 后审阅');
  let review, findings = [];
  if (reviewId) {
    review = await db('la_reviews').where({ id: reviewId, status: 'completed' }).first();
    if (!review) fail(409, 'REVIEW_INCOMPLETE', '审查完成后才能带入本次意见');
    await accessible(db, user, review.contract_id);
    await require('./joint-intake').reviewDocument(db, user, review, version.id);
    if (review.version_id !== version.id && !review.snapshot?.jointGroup?.documents.some(d => d.versionId === version.id && d.contractId === contract.id && d.sha256 === version.sha256)) fail(409, 'REVIEW_VERSION_CHANGED', '审查意见与所选合同版本不一致');
    findings = await db('la_findings').where({ review_id: review.id }).orderBy('created_at').orderBy('id');
    if (review.snapshot?.jointGroup) findings = require('./joint-review').evidenceForFile(findings, version.id, review.version_id);
  }
  const source = converted ? { ...version, filename: version.filename.replace(/\.[^.]+$/, '.docx') } : version;
  const bytes = await storage.read(converted?.storage_key || version.storage_key), expected = converted?.sha256 || (!converted && version.sha256);
  if (expected && storage.sha256(bytes) !== expected) fail(409, 'FILE_INTEGRITY', '审阅基线文件完整性校验失败');
  return editorDocument(bytes, source, review, findings);
}

async function sourceReview(db, user, contract, reviewId) {
  if (contract.source_data?.autoReviewBatchId) {
    const batch = await require('./auto-review-batch').publicBatch(db, user, contract.source_data.autoReviewBatchId, false);
    reviewId = batch.main_review_id;
  }
  const run = await db('la_reviews').where({ id: reviewId || contract.current_review_id || null }).first();
  if (!run) return null;
  const document = run.snapshot?.documents?.find(d => d.contractId === contract.id);
  if (run.contract_id !== contract.id && !document) return null;
  await accessible(db, user, run.contract_id);
  return { run, reviewedVersionId: document?.versionId || run.version_id };
}

// Browser DOCX editing uses the same immutable versions and access rules as
// other contract edits. It does not need an external Document Server session.
function router(db) {
  const r = express.Router();
  r.get('/contracts/:id/review-document', wrap(async (req, res) => {
    const c = await accessible(db, req.user, uuid.parse(req.params.id));
    const versionId = uuid.optional().parse(req.query.versionId) || c.current_version_id;
    const v = await db('la_versions').where({ id: versionId, contract_id: c.id }).first();
    if (!v) fail(404, 'VERSION_NOT_FOUND', '合同文件版本不存在');
    const reviewId = uuid.optional().parse(req.query.reviewId);
    const buffer = await openedDocument(db, req.user, c, v, reviewId);
    res.set('Cache-Control', 'private, no-store').type('application/vnd.openxmlformats-officedocument.wordprocessingml.document').send(buffer);
  }));
  r.post('/contracts/:id/review-document', requireRole('legal'), upload.single('file'), wrap(async (req, res) => {
    const baseVersionId = uuid.parse(req.body.baseVersionId);
    const reviewId = uuid.optional().parse(req.body.reviewId);
    const reason = z.string().trim().max(3000).default('').parse(req.body.reviewReason);
    let actions;
    try { actions = actionSchema.parse(JSON.parse(req.body.reviewActions || '[]')); }
    catch { fail(400, 'REVIEW_ACTIONS_INVALID', '审阅操作记录格式无效，修改仍保留在页面中'); }
    if (!req.file || !req.file.originalname.toLowerCase().endsWith('.docx')) fail(400, 'DOCX_ONLY', '请保存 DOCX 格式的审阅文件');
    // Validate the package, expansion bound and document XML before storing it.
    const parsed = parseDocx(req.file.buffer);
    const result = await db.transaction(async trx => {
      const c = await accessible(trx, req.user, uuid.parse(req.params.id), true);
      const base = await trx('la_versions').where({ id: baseVersionId, contract_id: c.id }).first();
      if (!base) fail(404, 'VERSION_NOT_FOUND', '审阅基线版本不存在');
      if (c.current_version_id !== baseVersionId) {
        // Generated drafts are immutable branches of the reviewed original.
        // A first human save may adopt the current batch's draft only while
        // its original is still current. Later saves use the normal stale check.
        const draft = await trx('la_versions').where({ id: baseVersionId, contract_id: c.id, parent_id: c.current_version_id }).whereIn('source_action', ['auto_review_draft', 'auto_review_comments']).first();
        const artifact = draft && await trx('la_auto_review_artifacts as a')
          .join('la_auto_review_batches as b', 'b.id', 'a.batch_id')
          .where({ 'a.version_id': draft.id, 'a.source_version_id': c.current_version_id, 'a.status': 'ready' }).whereIn('a.kind', ['tracked_revisions', 'annotated_comments'])
          .whereColumn('a.review_id', 'b.main_review_id').whereIn('b.status', ['completed', 'partial']).first('b.container_id');
        if (!artifact) fail(409, 'REVIEW_DOCUMENT_STALE', '合同已有新版本，当前修改仍留在页面中，请先下载保留后重新打开最新版');
        await accessible(trx, req.user, artifact.container_id);
      }
      const context = await sourceReview(trx, req.user, c, reviewId);
      const baselineReviewId = reviewId || (context?.run.status === 'completed' && context.run.version_id === base.id ? context.run.id : undefined);
      const before = await openedDocument(trx, req.user, c, base, baselineReviewId);
      const evidence = learning.compare(learning.snapshot(before), learning.snapshot(req.file.buffer), actions, reason);
      const value = await addVersion(trx, c, req.file, req.user.id, 'margin_review', 'contract', { skipLearning: true });
      await trx('la_versions').where({ id: value.version.id }).update({ parsed: JSON.stringify(parsed), ...(!value.duplicate ? { parent_id: baseVersionId } : {}) });
      let sourceId = null;
      if (context && (!value.duplicate || reason)) sourceId = await require('./agent/memory').record(trx, req.user, {
        contractId: c.id, reviewId: context.run.id, kind: 'review_revision',
        eventKey: 'review-document:' + base.id + ':' + value.version.id + ':' + storage.sha256(Buffer.from(reason)),
        source: { batchId: c.source_data?.autoReviewBatchId || null, beforeVersionId: base.id, afterVersionId: value.version.id, reviewedVersionId: context.reviewedVersionId,
          beforeVersionNo: base.version_no, afterVersionNo: value.version.version_no, baselineKind: base.source_action === 'auto_review_comments' ? 'AI 批注建议稿' : base.source_action === 'auto_review_draft' ? 'AI 自动修订稿' : '已保存的审阅版本',
          beforeSha256: base.sha256, afterSha256: value.version.sha256, review: evidence },
      });
      await audit(trx, req.user, 'document.margin_review_save', c.id, { baseVersionId, versionId: value.version.id, duplicate: value.duplicate });
      return { versionId: value.version.id, versionNo: value.version.version_no, saved: !value.duplicate,
        learning: { sourceId, status: sourceId ? evidence.substantive ? 'queued' : 'recorded' : 'skipped',
          message: sourceId ? evidence.substantive ? '已保存法务处理，后台将尝试提炼技能草稿，审核通过后才复用。' : '已记录文档状态变化；仅处理批注或未改变审阅内容，不据此生成技能。' : '修改已保存，本次未新增经验整理来源。' } };
    });
    res.json(result);
  }));
  return r;
}
module.exports = { router };
