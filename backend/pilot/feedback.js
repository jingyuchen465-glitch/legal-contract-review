const { randomUUID } = require('node:crypto');
const { z } = require('zod');
const { fail, wrap } = require('./errors');
const { audit, accessible, requireRole } = require('./auth');
const { createDraft } = require('./rules');
const { findType, tags } = require('./catalog');

async function context(db, user, feedback) {
  const run = feedback.review_id && await db('la_reviews').where({ id: feedback.review_id }).first();
  if (!run) fail(409, 'FEEDBACK_REVIEW_REQUIRED', '反馈未关联预审任务，请从合同审核详情提交');
  const contract = await accessible(db, user, run.contract_id);
  const version = await db('la_versions').where({ id: run.version_id }).first();
  const finding = feedback.finding_id && await db('la_findings').where({ id: feedback.finding_id, review_id: run.id }).first();
  return { run, contract, version, finding };
}
async function feedbackRow(db, id, lock = false) {
  let query = db('la_feedback').where({ id: z.string().uuid().parse(id) });
  if (lock) query = query.forUpdate();
  const row = await query.first();
  if (!row) fail(404, 'FEEDBACK_NOT_FOUND', '反馈不存在');
  if (lock && row.state === 'retired') fail(409, 'FEEDBACK_RETIRED', '已停用反馈不能生成草稿或样本');
  return row;
}
async function sourcePack(db, run, finding, packId) {
  if (packId) {
    const row = await db('la_rule_versions').where({ pack_id: packId, state: 'published' }).first();
    if (!row) fail(409, 'RULE_SOURCE_NOT_FOUND', '所选规则包没有正式版本');
    return row;
  }
  const rule = run.snapshot?.rules?.find(r => r.id === finding?.rule_id);
  // Trial version IDs are snapshot labels, not UUIDs stored in la_rule_versions.
  const historical = z.string().uuid().safeParse(rule?.packVersionId).success
    ? await db('la_rule_versions').where({ id: rule.packVersionId }).first() : null;
  const snapshotPacks = rule?.packVersionId ? (run.snapshot.packs || []).filter(p => p.id === rule.packVersionId) : [];
  const sourcePackId = historical?.pack_id || (snapshotPacks.length === 1 ? snapshotPacks[0].packId : null);
  if (sourcePackId) {
    const current = await db('la_rule_versions').where({ pack_id: sourcePackId, state: 'published' }).first();
    if (current) return current;
  }
  // Never choose the first pack just because its rule ID happens to match.
  fail(409, 'RULE_SELECTION_REQUIRED', '无法唯一定位当前规则，请选择要修改的正式规则包');
}
async function makeRuleDraft(db, user, id, input = {}, knowledge = false) {
  return db.transaction(async trx => {
    const initial = await feedbackRow(trx, id);
    const initialContext = await context(trx, user, initial);
    const existing = initial.draft_rule_version_id && await trx('la_rule_versions').where({ id: initial.draft_rule_version_id }).whereIn('state', ['draft', 'pending']).first();
    const source = existing || await sourcePack(trx, initialContext.run, initialContext.finding, input.packId);
    // Publication also takes the pack lock before touching feedback rows.
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`pack:${source.pack_id}`]);
    const f = await feedbackRow(trx, id, true);
    if (knowledge ? f.kind !== 'normal_expression' : !['rule', 'false_positive', 'false_negative'].includes(f.kind)) fail(409, 'FEEDBACK_KIND', '反馈类型与此操作不匹配');
    const ctx = await context(trx, user, f);
    const oldDraft = f.draft_rule_version_id && await trx('la_rule_versions').where({ id: f.draft_rule_version_id }).whereIn('state', ['draft', 'pending']).first();
    if (oldDraft) {
      const ruleId = oldDraft.rules.some(r => r.id === ctx.finding?.rule_id) ? ctx.finding.rule_id : oldDraft.rules.find(r => !ctx.run.snapshot?.rules?.some(old => old.id === r.id))?.id;
      return { feedbackId: f.id, packId: oldDraft.pack_id, ruleId, draft: oldDraft, sourcePublishedVersionId: oldDraft.base_version_id, reused: true };
    }
    const latest = await trx('la_rule_versions').where({ pack_id: source.pack_id, state: 'published' }).first();
    if (latest?.id !== source.id) fail(409, 'REVISION_CONFLICT', '正式规则已更新，请刷新后重试');
    const rules = structuredClone(source.rules), materials = structuredClone(source.knowledge || []);
    let ruleId = ctx.finding?.rule_id;
    if (knowledge) {
      materials.push({ id: `feedback-${f.id}-${randomUUID()}`, title: `法务确认的正常表达：${ctx.finding?.title || '参考案例'}`, content: f.content, source: `合同 ${ctx.contract.number} / 文件 v${ctx.version.version_no} / 反馈 ${f.id}`, effectiveDate: new Date().toISOString().slice(0, 10) });
    } else if (!rules.some(r => r.id === ruleId)) {
      // Manual findings and removed rules require an explicit choice, then get a new ID.
      if (!input.packId) fail(409, 'RULE_SELECTION_REQUIRED', '该检查项不在当前规则中，请选择规则包后补充新检查项');
      ruleId = `rule-${randomUUID()}`;
      rules.push({ id: ruleId, title: ctx.finding?.title || '反馈新增检查项', instruction: f.content, severity: ctx.finding?.disposition?.severity || ctx.finding?.severity || 'medium', mandatory: true, tags: [] });
    }
    const draft = await createDraft(trx, source.pack_id, { name: source.name, scope: source.scope, rules, knowledge: materials }, user.id);
    await trx('la_rule_versions').where({ id: draft.id }).update({ base_version_id: source.id, source_feedback_id: f.id });
    Object.assign(draft, { base_version_id: source.id, source_feedback_id: f.id });
    await trx('la_feedback').where({ id: f.id }).update({ draft_rule_version_id: draft.id, revision: trx.raw('revision + 1'), updated_at: trx.fn.now() });
    await audit(trx, user, knowledge ? 'feedback.knowledge-draft' : 'feedback.rule-draft', f.id, { draftVersionId: draft.id, sourcePublishedVersionId: source.id, ruleId });
    return { feedbackId: f.id, packId: source.pack_id, ruleId, draft, sourcePublishedVersionId: source.id, reused: false };
  });
}

function expectedFromReview(ctx, findings) {
  const current = ctx.contract.current_version_id === ctx.version.id;
  const classification = current && ctx.contract.classification?.confirmed ? ctx.contract.classification : ctx.run.snapshot?.classification;
  const risks = findings.filter(f => {
    if (f.disposition?.action === 'reject' || f.disposition?.action === 'needs_information') return false;
    return f.disposition ? f.check_status === 'fail' || f.disposition.action === 'correct' : f.check_status === 'fail';
  });
  const available = (ctx.run.snapshot.rules || []).map(r => ({ id: r.id, title: r.title }));
  // Manual finding IDs aren't executable rules: don't silently label them as positives.
  const valid = new Set(available.map(r => r.id));
  const riskRuleIds = risks.filter(f => valid.has(f.rule_id)).map(f => f.rule_id);
  return {
    typeId: classification?.typeId || '', tags: classification?.tags || [],
    riskRuleIds, highRiskRuleIds: risks.filter(f => riskRuleIds.includes(f.rule_id) && (f.disposition?.severity || f.severity) === 'high').map(f => f.rule_id),
    background: ctx.run.snapshot.background || ctx.contract.background,
  };
}
async function samplePreview(db, user, id) {
  const f = await feedbackRow(db, id), ctx = await context(db, user, f);
  if (!ctx.version?.parsed?.blocks?.length) fail(409, 'EVALUATION_DOCUMENT_REQUIRED', '合同尚未完成解析');
  const findings = await db('la_findings').where({ review_id: ctx.run.id });
  const rules = new Map((ctx.run.snapshot.rules || []).map(r => [r.id, { id: r.id, title: r.title }]));
  for (const p of await db('la_rule_versions').where({ state: 'published' })) for (const r of p.rules) rules.set(r.id, { id: r.id, title: r.title });
  return { name: `反馈样本 · ${ctx.contract.title}`, split: 'development', document: ctx.version.parsed, expected: expectedFromReview(ctx, findings), rules: [...rules.values()], source: { feedback: f, contractId: ctx.contract.id, contractTitle: ctx.contract.title, version: ctx.version.version_no, reviewId: ctx.run.id, requiresConfirmation: findings.some(f => f.check_status !== 'pass' && !f.disposition) } };
}
const sampleExpected = z.object({ typeId: z.string(), tags: z.array(z.enum(tags)), riskRuleIds: z.array(z.string()), highRiskRuleIds: z.array(z.string()), background: z.object({ ourEntity: z.string(), perspective: z.string(), purpose: z.string() }) });
function mountFeedbackRoutes(r, db) {
  r.use('/feedback-cases/:id', requireRole('legal', 'publisher'));
  r.post('/feedback-cases/:id/rule-draft', wrap(async (req, res) => res.status(201).json(await makeRuleDraft(db, req.user, req.params.id, z.object({ packId: z.string().optional() }).parse(req.body || {})))));
  r.post('/feedback-cases/:id/knowledge-draft', wrap(async (req, res) => res.status(201).json(await makeRuleDraft(db, req.user, req.params.id, z.object({ packId: z.string().optional() }).parse(req.body || {}), true))));
  r.get('/feedback-cases/:id/context', wrap(async (req, res) => {
    const f = await feedbackRow(db, req.params.id), ctx = await context(db, req.user, f);
    res.json({ feedback: f, contract: { id: ctx.contract.id, title: ctx.contract.title }, version: { id: ctx.version.id, version_no: ctx.version.version_no }, finding: ctx.finding || null, submittedBy: (await db('la_users').where({ id: f.created_by }).first())?.display_name });
  }));
  r.get('/feedback-cases/:id/evaluation-preview', wrap(async (req, res) => res.json(await samplePreview(db, req.user, req.params.id))));
  r.post('/feedback-cases/:id/evaluation-case', wrap(async (req, res) => {
    const input = z.object({ name: z.string().trim().min(1), split: z.enum(['development', 'holdout']), expected: sampleExpected, confirmed: z.literal(true) }).parse(req.body);
    const preview = await samplePreview(db, req.user, req.params.id);
    if (!findType(input.expected.typeId)) fail(400, 'UNKNOWN_TYPE', '请确认正确的合同类型');
    const rules = new Set(preview.rules.map(r => r.id));
    if (input.expected.riskRuleIds.some(id => !rules.has(id)) || input.expected.highRiskRuleIds.some(id => !input.expected.riskRuleIds.includes(id))) fail(400, 'INVALID_EXPECTED_RULE', '高风险项必须属于预期风险，且规则必须存在');
    const row = await db.transaction(async trx => {
      const f = await feedbackRow(trx, req.params.id, true);
      const existing = await trx('la_evaluation_cases').where({ source_feedback_id: f.id }).first();
      if (existing) return existing;
      const result = (await trx('la_evaluation_cases').insert({ id: randomUUID(), name: input.name, split: input.split, expected: JSON.stringify(input.expected), document: JSON.stringify(preview.document), created_by: req.user.id, source_feedback_id: f.id }).returning('*'))[0];
      await audit(trx, req.user, 'feedback.evaluation-case', f.id, { evaluationCaseId: result.id });
      return result;
    }); res.status(201).json(row);
  }));
}
module.exports = { mountFeedbackRoutes, context, feedbackRow, samplePreview };
