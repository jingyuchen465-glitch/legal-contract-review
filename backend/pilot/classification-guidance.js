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
}
module.exports = { mountGuidanceRoutes, guidanceSchema };
