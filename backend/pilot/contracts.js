const { randomUUID } = require('node:crypto');
const storage = require('./storage');
const { enqueueReview } = require('./workflow');
const { fail } = require('./errors');
async function addVersion(db, c, file, actorId, action = 'upload', kind = 'contract') {
  const media = storage.validateUpload(file), hash = storage.sha256(file.buffer);
  const current = c.current_version_id && await db('la_versions').where({ id: c.current_version_id }).first();
  if (kind === 'contract' && current?.sha256 === hash) return { version: current, duplicate: true, reviewId: c.current_review_id };
  const max = await db('la_versions').where({ contract_id: c.id }).max('version_no as n').first();
  const id = randomUUID(), filename = storage.safeName(file.originalname);
  const key = await storage.put(file.buffer, c.id, id, filename);
  const row = { id, contract_id: c.id, version_no: Number(max.n || 0) + 1, parent_id: c.current_version_id || null, kind, filename, sha256: hash, storage_key: key, media_type: media, size: file.buffer.length, source_action: action, created_by: actorId };
  const version = (await db('la_versions').insert(row).returning('*'))[0];
  if (kind !== 'contract') return { version, duplicate: false };
  const classification = c.classification ? { ...c.classification, confirmed: false, versionId: id, perspectiveConfirmed: false } : null;
  await db('la_contracts').where({ id: c.id }).update({ current_version_id: id, classification: classification ? JSON.stringify(classification) : null, legal_status: 'pending_review', revision: db.raw('revision + 1'), updated_at: db.fn.now() });
  const reviewId = await enqueueReview(db, { ...c, current_version_id: id }, actorId);
  return { version, duplicate: false, reviewId };
}
async function createContract(db, actor, file, {
  title,
  background,
  source = 'manual',
  sourceData = {},
  reviewerId = null,
  intakeMode = source === 'dingtalk' ? 'live' : 'manual',
  intakeReviewStatus = intakeMode === 'reconciliation' ? 'pending' : 'confirmed',
} = {}) {
  if (!['live', 'reconciliation', 'manual'].includes(intakeMode)) throw new Error('无效的合同收件方式');
  if (!['confirmed', 'pending', 'dismissed'].includes(intakeReviewStatus)) throw new Error('无效的收件确认状态');
  const id = randomUUID();
  const row = { id, number: `LA-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${id.slice(0, 8).toUpperCase()}`, title: title || storage.safeName(file.originalname), submitter_id: actor.id, department: actor.department, reviewer_id: reviewerId, source, source_data: JSON.stringify(sourceData), background: JSON.stringify(background || {}), intake_mode: intakeMode, intake_review_status: intakeReviewStatus };
  await db('la_contracts').insert(row);
  const c = await db('la_contracts').where({ id }).first(); const result = await addVersion(db, c, file, actor.id);
  return { contract: await db('la_contracts').where({ id }).first(), ...result };
}
module.exports = { addVersion, createContract };
