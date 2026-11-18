const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { config } = require('./config');
const { accessible, audit } = require('./auth');
const { fail } = require('./errors');
const { createGateway } = require('./model');
const { parseDocx } = require('./parser');
const { applyClauseRevisions } = require('./clause-revisions');
const { addVersion } = require('./contracts');
const storage = require('./storage');

const inputSchema = z.object({ reviewId: z.string().uuid(), findingId: z.string().uuid() });
const findingDigest = finding => storage.sha256(Buffer.from(JSON.stringify([finding.revision, finding.reason, finding.suggestion, finding.disposition, finding.evidence, finding.document_suggestions])));
async function wordSource(version) {
  const artifact = version.conversion?.artifacts?.docx;
  if (!version.filename.toLowerCase().endsWith('.docx') && !artifact) fail(422, 'DOCX_ONLY', '请先将合同转换为 Word');
  return { buffer: await storage.read(artifact?.storage_key || version.storage_key), filename: artifact ? version.filename.replace(/\.[^.]+$/, '.docx') : version.filename };
}
async function context(db, user, contract, session, ids) {
  if (contract.current_version_id !== session.version_id) fail(409, 'EDITOR_STALE', '合同已有其他新版本，请重新打开编辑器');
  const run = await db('la_reviews').where({ id: ids.reviewId, status: 'completed' }).first();
  if (!run) fail(404, 'REVIEW_NOT_FOUND', '已完成的审查记录不存在');
  await accessible(db, user, run.contract_id);
  const sourceId = run.contract_id === contract.id ? run.version_id : run.snapshot?.jointGroup?.documents.find(d => d.contractId === contract.id)?.versionId;
  if (!sourceId) fail(403, 'DRAFT_DOCUMENT_SCOPE', '意见不属于当前文件');
  const visited = new Set(); let cursor = session.version_id, version;
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const row = await db('la_versions').where({ id: cursor, contract_id: contract.id }).first();
    if (!row) break;
    version ||= row;
    if (row.id === sourceId) break;
    cursor = row.parent_id;
  }
  if (!visited.has(sourceId)) fail(409, 'DRAFT_REVIEW_VERSION', '审查意见不属于当前文件的版本链');
  const finding = await db('la_findings').where({ id: ids.findingId, review_id: run.id }).first();
  if (!finding || finding.check_status === 'pass' || finding.disposition?.action === 'reject') fail(409, 'DRAFT_FINDING_UNAVAILABLE', '该意见无须修改或已被驳回');
  const scoped = require('./joint-review').evidenceForFile([finding], sourceId, run.version_id)[0];
  if (!scoped) fail(403, 'DRAFT_DOCUMENT_SCOPE', '意见未指向当前文件');
  return { run, finding, scoped, version, sourceId };
}

async function generateDraft(db, user, contract, session, body) {
  const ids = inputSchema.parse(body);
  const data = await context(db, user, contract, session, ids);
  const source = await wordSource(data.version), parsed = parseDocx(source.buffer);
  const reviewed = await db('la_versions').where({ id: data.sourceId }).first();
  const targets = new Set();
  for (const evidence of data.scoped.evidence || []) {
    const oldBlock = reviewed.parsed?.blocks.find(b => b.id === evidence.blockId);
    const whole = oldBlock && parsed.blocks.filter(b => b.text === oldBlock.text && b.text.includes(evidence.quote));
    const matches = whole?.length === 1 ? whole : parsed.blocks.filter(b => evidence.quote && b.text.includes(evidence.quote));
    if (matches.length !== 1) fail(409, 'DRAFT_ANCHOR_CHANGED', '引用条款已修改、删除或有多处相同原文，请重新预审或人工修改');
    targets.add(matches[0].id);
  }
  if (!targets.size && data.finding.kind !== 'missing') fail(409, 'DRAFT_NO_ANCHOR', '该项缺少可靠原文位置，请先补充材料或人工核实');
  const allowedBlockIds = targets.size ? [...targets] : parsed.blocks.map(b => b.id);
  const blocks = targets.size ? parsed.blocks.filter((b, i, list) => targets.has(b.id) || targets.has(list[i - 1]?.id) || targets.has(list[i + 1]?.id)) : parsed.blocks;
  if (blocks.reduce((n, b) => n + b.text.length, 0) > 120000) fail(422, 'DRAFT_CONTEXT_TOO_LARGE', '缺失条款尚无插入位置，全文过长，请先由法务补充具体位置');
  const draft = await createGateway(db).draftClause({
    filename: source.filename, background: data.run.snapshot?.background || contract.background,
    finding: { title: data.finding.title, kind: data.finding.kind, reason: data.finding.reason, suggestion: data.finding.disposition?.suggestion ?? data.scoped.suggestion, evidence: data.scoped.evidence },
    blocks, allowedBlockIds,
  });
  if (data.finding.kind === 'missing' && draft.edits.some(e => e.operation !== 'insert_after')) fail(422, 'INVALID_EVIDENCE', '缺失条款只能新增，不能替换或删除其他条款');
  // Check compatibility before offering an apply button.
  applyClauseRevisions(source.buffer, draft, user.display_name);
  const claims = { ...ids, editorKey: session.key, userId: user.id, versionId: data.version.id, sha256: data.version.sha256, findingDigest: findingDigest(data.finding), draft };
  const token = jwt.sign(claims, config.tokenSecret, { algorithm: 'HS256', audience: 'clause-draft', expiresIn: '30m' });
  await audit(db, user, 'document.clause_draft', contract.id, { ...ids, versionId: data.version.id, edits: draft.edits.length });
  return { ...draft, versionId: data.version.id, token };
}

async function applyDraft(db, user, contractId, key, token) {
  let claims;
  try { claims = jwt.verify(z.string().max(1000000).parse(token), config.tokenSecret, { algorithms: ['HS256'], audience: 'clause-draft' }); }
  catch { fail(409, 'DRAFT_EXPIRED', '改稿已过期或无效，请重新生成'); }
  if (claims.editorKey !== key || claims.userId !== user.id) fail(403, 'DRAFT_SCOPE', '改稿不属于当前编辑会话');
  return db.transaction(async trx => {
    // Lock in the same order as the OnlyOffice callback.
    const session = await trx('la_editor_sessions').where({ key, contract_id: contractId, user_id: user.id }).forUpdate().first();
    if (!session || new Date(session.expires_at) < new Date()) fail(409, 'EDITOR_SESSION_EXPIRED', '编辑会话已失效，请重新打开编辑器');
    const contract = await accessible(trx, user, contractId, true);
    const data = await context(trx, user, contract, session, claims);
    const finding = await trx('la_findings').where({ id: data.finding.id }).forUpdate().first();
    if (claims.versionId !== session.version_id || claims.sha256 !== data.version.sha256 || claims.findingDigest !== findingDigest(finding)) fail(409, 'DRAFT_STALE', '正文或复核意见已改变，请重新生成改稿后再应用');
    const source = await wordSource(data.version);
    let base = source.buffer;
    if (data.version.id === data.sourceId && !parseDocx(base).originalComments.some(c => c.author === 'AI 合同预审' && c.text.includes(data.run.id))) {
      const findings = await trx('la_findings').where({ review_id: data.run.id }).orderBy('created_at').orderBy('id');
      const scoped = require('./joint-review').evidenceForFile(findings, data.sourceId, data.run.version_id);
      base = require('./office-document').editorDocument(base, { ...data.version, filename: source.filename, parsed: parseDocx(base) }, data.run, scoped);
    }
    const buffer = applyClauseRevisions(base, claims.draft, `${user.display_name}（AI 改稿）`);
    const result = await addVersion(trx, contract, { originalname: source.filename, buffer }, user.id, 'ai_clause_revision');
    // Close the old editor key so a late callback cannot overwrite this version.
    await trx('la_editor_sessions').where({ key }).update({ expires_at: new Date(0) });
    await audit(trx, user, 'document.clause_apply', contract.id, { reviewId: data.run.id, findingId: finding.id, sourceVersionId: data.version.id, versionId: result.version.id, edits: claims.draft.edits.length });
    return { saved: true, versionId: result.version.id, versionNo: result.version.version_no };
  });
}

module.exports = { generateDraft, applyDraft };
