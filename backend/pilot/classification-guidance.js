const { randomUUID } = require('node:crypto');
const { z } = require('zod');
const { fail, wrap } = require('./errors');
const { audit, assertRevision, requireRole } = require('./auth');
const { findType } = require('./catalog');
const { context, feedbackRow } = require('./feedback');
const guidanceSchema = z.object({ description: z.string().trim().min(1).max(10000), include: z.array(z.string().trim().min(1).max(2000)).default([]), exclude: z.array(z.string().trim().min(1).max(2000)).default([]), examples: z.array(z.string().trim().min(1).max(5000)).default([]) });
async function create(db, user, typeId, guidance, feedbackId) {
  if (!findType(typeId)) fail(400, 'UNKNOWN_TYPE', '请选择目录内合同类型');
  await db.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`classification:${typeId}`]);
  const last = await db('la_classification_guidance_versions').where({ type_id: typeId }).max('version_no as version').first();
  const source = await db('la_classification_guidance_versions').where({ type_id: typeId, state: 'published' }).first();
  return (await db('la_classification_guidance_versions').insert({ id: randomUUID(), type_id: typeId, version_no: Number(last?.version || 0) + 1, guidance: JSON.stringify(guidance), base_version_id: source?.id || null, created_by: user.id, source_feedback_id: feedbackId || null }).returning('*'))[0];
}
function mountGuidanceRoutes(r, db) {
  r.use(['/classification-guidance', '/classification-guidance-versions'], requireRole('publisher'));
  r.get('/classification-guidance', wrap(async (req, res) => res.json(await db('la_classification_guidance_versions').orderBy('type_id').orderBy('version_no', 'desc'))));
  r.post('/classification-guidance/:typeId/versions', wrap(async (req, res) => {
    const input = guidanceSchema.parse(req.body);
    const row = await db.transaction(async trx => { const row = await create(trx, req.user, req.params.typeId, input); await audit(trx, req.user, 'classification-guidance.draft', row.id); return row; });
    res.status(201).json(row);
  }));
  r.put('/classification-guidance-versions/:id', wrap(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id), guidance = guidanceSchema.parse(req.body);
    const row = await db.transaction(async trx => {
      const row = await trx('la_classification_guidance_versions').where({ id }).forUpdate().first();
      if (!row) fail(404, 'GUIDANCE_NOT_FOUND', '分类指导不存在');
      assertRevision(row, req.body.revision); if (row.state !== 'draft') fail(409, 'GUIDANCE_STATE', '仅草稿可编辑');
      const [updated] = await trx('la_classification_guidance_versions').where({ id }).update({ guidance: JSON.stringify(guidance), revision: trx.raw('revision + 1'), updated_at: trx.fn.now() }).returning('*');
      await audit(trx, req.user, 'classification-guidance.edit', id); return updated;
    }); res.json(row);
  }));
  r.post('/classification-guidance-versions/:id/publish', wrap(async (req, res) => {
    const id = z.string().uuid().parse(req.params.id);
    await db.transaction(async trx => {
      const initial = await trx('la_classification_guidance_versions').where({ id }).first(); if (!initial) fail(404, 'GUIDANCE_NOT_FOUND', '分类指导不存在');
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`classification:${initial.type_id}`]);
      const row = await trx('la_classification_guidance_versions').where({ id }).forUpdate().first();
      assertRevision(row, req.body.revision); if (row.state !== 'draft') fail(409, 'GUIDANCE_STATE', '分类指导不是草稿');
      guidanceSchema.parse(row.guidance);
      const current = await trx('la_classification_guidance_versions').where({ type_id: row.type_id, state: 'published' }).first();
      if ((current?.id || null) !== row.base_version_id) fail(409, 'GUIDANCE_BASE_CHANGED', '分类指导已有新版本发布，请基于最新版本重新修改');
      await trx('la_classification_guidance_versions').where({ type_id: row.type_id, state: 'published' }).update({ state: 'retired', revision: trx.raw('revision + 1') });
      await trx('la_classification_guidance_versions').where({ id }).update({ state: 'published', published_by: req.user.id, published_at: trx.fn.now(), revision: trx.raw('revision + 1'), updated_at: trx.fn.now() });
      if (row.source_feedback_id) {
        await trx('la_feedback').where({ id: row.source_feedback_id }).whereNot({ state: 'retired' }).update({ state: 'published', classification_version_id: id, revision: trx.raw('revision + 1'), updated_at: trx.fn.now() });
        await audit(trx, req.user, 'feedback.classification-published', row.source_feedback_id, { guidanceVersionId: id });
      }
      await audit(trx, req.user, 'classification-guidance.publish', id);
    }); res.json({ ok: true });
  }));
  r.post('/feedback-cases/:id/classification-draft', wrap(async (req, res) => {
    const result = await db.transaction(async trx => {
      const initial = await feedbackRow(trx, req.params.id);
      const ctx = await context(trx, req.user, initial);
      const existing = initial.draft_classification_version_id && await trx('la_classification_guidance_versions').where({ id: initial.draft_classification_version_id, state: 'draft' }).first();
      const typeId = existing?.type_id || req.body?.typeId || (ctx.contract.current_version_id === ctx.version.id && ctx.contract.classification?.confirmed ? ctx.contract.classification.typeId : null);
      if (!findType(typeId)) fail(409, 'CLASSIFICATION_TYPE_REQUIRED', '请先选择正确的合同类型');
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`classification:${typeId}`]);
      const f = await feedbackRow(trx, req.params.id, true);
      if (f.kind !== 'classification') fail(409, 'FEEDBACK_KIND', '只有分类纠错反馈可以修改分类指导');
      const old = f.draft_classification_version_id && await trx('la_classification_guidance_versions').where({ id: f.draft_classification_version_id, state: 'draft' }).first();
      if (old) return { feedbackId: f.id, draft: old, typeId: old.type_id, reused: true };
      // The human-selected corrected type must take precedence over the AI snapshot.
      const source = await trx('la_classification_guidance_versions').where({ type_id: typeId, state: 'published' }).first();
      const draft = await create(trx, req.user, typeId, source?.guidance || { description: f.content, include: [], exclude: [], examples: [] }, f.id);
      await trx('la_feedback').where({ id: f.id }).update({ draft_classification_version_id: draft.id, revision: trx.raw('revision + 1'), updated_at: trx.fn.now() });
      await audit(trx, req.user, 'feedback.classification-draft', f.id, { typeId, draftVersionId: draft.id });
      return { feedbackId: f.id, draft, typeId, reused: false };
    }); res.status(201).json(result);
  }));
}
module.exports = { mountGuidanceRoutes, guidanceSchema };
