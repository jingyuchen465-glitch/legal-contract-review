const { createHash, randomUUID } = require('node:crypto');
const { z } = require('zod');
const { accessible, audit } = require('./auth');
const { fail } = require('./errors');
const storage = require('./storage');
const { addVersion } = require('./contracts');
const { annotatedContract } = require('./annotated-contract');
const { parseDocx } = require('./parser');
const { reviewDocument } = require('./joint-intake');
const { groupFindings } = require('./finding-groups');

const modeSchema = z.enum(['comments', 'color']).default('comments');

function digestFindings(findings, mode) {
  return createHash('sha256').update(JSON.stringify({ mode, findings: findings.map(f => ({
    id: f.id,
    revision: f.revision,
    check_status: f.check_status,
    kind: f.kind,
    severity: f.severity,
    reason: f.reason,
    suggestion: f.suggestion,
    evidence: f.evidence,
    disposition: f.disposition,
  })) })).digest('hex');
}

function publicResult(row, version, sourceVersionId, locatedFindingIds, unlocatedFindingIds) {
  return {
    generated: true,
    versionId: version.id,
    versionNo: version.version_no,
    filename: version.filename,
    sourceVersionId,
    includedFindingIds: locatedFindingIds,
    unlocatedFindingIds,
    downloadUrl: `/api/files/${version.id}?download=1`,
    sha256: version.sha256,
    artifactId: row?.id,
    duplicate: !!row?.duplicate,
  };
}

async function sourceDocx(db, user, run) {
  const version = await reviewDocument(db, user, run, run.version_id);
  const converted = version.conversion?.artifacts?.docx;
  const key = converted?.storage_key || version.storage_key;
  const buffer = await storage.read(key);
  const expected = converted?.sha256 || version.sha256;
  if (storage.sha256(buffer) !== expected) fail(409, 'FILE_INTEGRITY', '合同文件校验未通过，请重新生成或联系管理员');
  const filename = converted ? version.filename.replace(/\.[^.]+$/, '.docx') : version.filename;
  if (!filename.toLowerCase().endsWith('.docx')) fail(422, 'ANNOTATION_DOCX_ONLY', '带批注建议稿仅支持 DOCX 或已完成 Word 转换的文件');
  return { version, buffer, filename, parsed: version.parsed || parseDocx(buffer) };
}

function scopedFindings(run, findings) {
  if (!run.snapshot?.jointGroup) return findings;
  return require('./joint-review').evidenceForFile(findings, run.version_id, run.version_id);
}

async function buildAnnotatedDocument(db, user, reviewId, mode = 'comments', { lock = false } = {}) {
  mode = modeSchema.parse(mode);
  const run = await db('la_reviews').where({ id: reviewId }).first();
  if (!run) fail(404, 'REVIEW_NOT_FOUND', '预审任务不存在');
  if (run.engine !== 'harness-v1') fail(410, 'REVIEW_ENGINE_RETIRED', '历史结果不能生成新的批注版本');
  if (run.status !== 'completed') fail(409, 'REVIEW_INCOMPLETE', '预审完成后才能生成批注建议稿');
  const actor = user || await db('la_users').where({ id: run.created_by, active: true }).first();
  if (!actor) fail(403, 'AGENT_ACCESS_REVOKED', '发起人的访问权限已失效');
  const contract = await accessible(db, actor, run.contract_id, lock);
  const source = await sourceDocx(db, actor, run);
  const findings = scopedFindings(run, await db('la_findings').where({ review_id: run.id }).orderBy('created_at').orderBy('id'));
  const result = annotatedContract(source.buffer, { ...source.version, filename: source.filename, parsed: source.parsed }, run, findings, mode);
  const ids = new Set(findings.flatMap(f => (f.relatedFindings || [{ id: f.id }]).map(x => x.id)));
  const locatedFindingIds = result.locatedFindingIds?.length ? result.locatedFindingIds : [...ids].slice(0, result.located);
  const unlocatedFindingIds = result.unlocatedFindingIds?.length ? result.unlocatedFindingIds : [...ids].slice(result.located);
  return { run, actor, contract, source, findings, result, mode, locatedFindingIds, unlocatedFindingIds, digest: digestFindings(findings, mode) };
}

async function createAnnotatedVersion(db, { reviewId, user, actorId, mode = 'comments' } = {}) {
  return db.transaction(async trx => {
    const prepared = await buildAnnotatedDocument(trx, user, reviewId, mode, { lock: true });
    const { run, actor, contract, source, result, locatedFindingIds, unlocatedFindingIds, digest } = prepared;
    const existing = await trx('la_annotated_versions').where({ review_id: run.id, source_version_id: source.version.id, mode: prepared.mode, finding_digest: digest }).first();
    if (existing) {
      const version = await trx('la_versions').where({ id: existing.generated_version_id, contract_id: contract.id }).first();
      if (version && storage.sha256(await storage.read(version.storage_key)) === version.sha256) {
        return publicResult({ ...existing, duplicate: true }, version, source.version.id, locatedFindingIds, unlocatedFindingIds);
      }
    }
    // Historical exports are read-only. Only an exact idempotent retry above
    // may use an older report, and it must never move the current pointer.
    if (source.version.id !== contract.current_version_id) {
      fail(409, 'ANNOTATION_REVIEW_STALE', '该报告对应历史版本，请等待当前版本审查完成；历史批注可通过下载导出');
    }
    await require('./joint-intake').assertCurrent(trx, contract, run.snapshot);
    const base = storage.safeName(source.filename).replace(/\.docx$/i, '');
    const filename = storage.safeName(`${base}_批注建议稿.docx`);
    const saved = await addVersion(trx, contract, { originalname: filename, buffer: result.buffer }, actorId || actor.id, 'ai_annotated_review');
    const row = (await trx('la_annotated_versions').insert({
      id: randomUUID(), review_id: run.id, source_version_id: source.version.id,
      generated_version_id: saved.version.id, mode: prepared.mode, finding_digest: digest,
      created_by: actorId || actor.id, located_count: locatedFindingIds.length, unlocated_count: unlocatedFindingIds.length,
    }).returning('*'))[0];
    await audit(trx, actor, 'contract.annotated_version_created', contract.id, {
      reviewId: run.id, sourceVersionId: source.version.id, versionId: saved.version.id,
      mode: prepared.mode, locatedFindingIds, unlocatedFindingIds, sourceSha256: source.version.sha256, sha256: saved.version.sha256,
    });
    return publicResult(row, saved.version, source.version.id, locatedFindingIds, unlocatedFindingIds);
  });
}

module.exports = { modeSchema, digestFindings, buildAnnotatedDocument, createAnnotatedVersion };
