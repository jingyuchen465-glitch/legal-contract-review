const { randomUUID, createHash } = require('node:crypto');
const { z } = require('zod');
const { fail, wrap, AppError } = require('./errors');
const { schemaIssues } = require('./review-diagnostics');
const { restrictedNames, privacyIssues } = require('./learning-privacy');
const { accessible, canRead, requireRole, assertRevision, audit } = require('./auth');
const { findType } = require('./catalog');
const { parseDocument } = require('./parser');
const { createGateway, providerConfig, publicModelSnapshot } = require('./model');
const { publishedSkills, packIdFor, createSkillDraft, validatePack } = require('./skills');
const { createDraft, applicable } = require('./rules');
const storage = require('./storage');
const { needsConversion } = require('./file-formats');
const { ensureConverted, parseConverted, persistDocument } = require('./conversion');
const { compareDocuments, markChanges, learningChunks, changePage } = require('./document-changes');
const { config } = require('./config');
const { activeTask,proposalUpdate,signature } = require('./knowledge-catalog');
const { confirmationQuery, requireConfirmation, requireTaskConfirmation } = require('./learning-confirmation');
const normalized = text => String(text || '').replace(/\s+/gu, '').toLowerCase();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const string = z.string().trim().min(1);
const proposalSchema = z.object({ key: string.max(100), kind: z.enum(['skill', 'rule']), scope: z.enum(['type', 'common']).default('type'),
  title: string.max(200), reason: string.max(3000), targetId: z.string().max(100).optional(), targetPackId: z.string().max(100).optional(),
  method: z.string().max(6000).default(''), conditions: z.array(string.max(2000)).max(100).default([]), exclusions: z.array(string.max(2000)).max(100).default([]), examples: z.array(string.max(3000)).max(50).default([]),
  instruction: z.string().max(10000).default(''), severity: z.enum(['high', 'medium', 'low']).default('medium'),
  applicability:z.object({anyTags:z.array(z.string()).default([]),excludeTags:z.array(z.string()).default([])}).optional(),
  evidence: z.array(z.object({ versionId: z.string().uuid(), blockId: string, quote: string.max(6000) })).max(100).default([]),
  findingIds: z.array(z.string().uuid()).max(20).default([]), dependsOn: z.array(string.max(100)).max(10).default([]) });
const outputSchema = z.object({ proposals: z.array(proposalSchema).max(50) });
function semanticKey(p) { return digest([p.kind, p.scope, p.targetId || null, p.targetPackId || null, normalized(p.title), normalized(p.method || p.instruction), p.conditions.map(normalized), p.exclusions.map(normalized), p.examples.map(normalized)]); }
function validateExperience(raw, { blocks, findings, snapshot, restrictedTerms = [],existingProposals=[] }) {
  const parsed = outputSchema.safeParse(raw);
  const invalid = (message, issues = []) => {
    const error = new AppError(422, 'LEARNING_OUTPUT_INVALID', message);
    error.diagnostics = { issues: schemaIssues(issues) };
    throw error;
  };
  if (!parsed.success) invalid('经验提案字段不完整或过长', parsed.error.issues);
  const proposals = parsed.data.proposals;
  if (new Set(proposals.map(p => p.key)).size !== proposals.length) invalid('经验提案编号重复');
  for (const [index, p] of proposals.entries()) {
    if(!config.learningCatalog.enabled&&(p.conditions.length>10||p.exclusions.length>10||p.examples.length>5||p.evidence.length>10))invalid('经验条目过长');
    if (!p.evidence.length && !p.findingIds.length) invalid('经验缺少可核对的原文或人工处理依据');
    for (const e of p.evidence) if (!blocks.some(b => b.versionId === e.versionId && b.sourceBlockId === e.blockId && b.text.includes(e.quote))) invalid('经验引用不属于当前输入片段或原文不匹配');
    if (p.findingIds.some(id => !findings.some(f => f.id === id && f.disposition))) invalid('经验引用的人工处理记录不存在');
    const issues = privacyIssues(p, index, restrictedTerms);
    if (issues.length) invalid('复用内容应使用主体等占位符，不应复制合同专属名称或联系方式', issues);
    if (p.kind === 'skill') {
      if (!p.method.trim()) invalid('技能缺少具体审查方法');
      const scope = { level: p.scope, typeIds: p.scope === 'type' ? [snapshot.typeId] : [] };
      const old = snapshot.skillPacks.find(pack => pack.scope.level===scope.level&&(scope.level==='common'||pack.scope.typeIds.includes(snapshot.typeId))&&(!p.targetPackId||pack.pack_id===p.targetPackId)&&(p.targetId?pack.skills.some(s=>s.id===p.targetId):pack.pack_id===packIdFor(scope)));
      if (p.targetId && !old?.skills.some(s => s.id === p.targetId)) invalid('待补充技能不属于该范围的正式技能包');
      if (p.dependsOn.some(key => !proposals.some(other => other.key === key && other.kind === 'rule')&&!existingProposals.some(other=>other.key===key&&other.kind==='rule'))) invalid('技能依赖的规则提案不存在');
    } else {
      if (!p.instruction.trim() || p.dependsOn.length) invalid('规则建议须提供检查标准，且不能循环依赖');
      if (p.targetPackId && !snapshot.rulePacks.some(pack => pack.pack_id === p.targetPackId)) invalid('规则建议的目标规则包不适用于本合同');
      if (p.targetId && !snapshot.rulePacks.some(pack => (!p.targetPackId || p.targetPackId === pack.pack_id) && pack.rules.some(r => r.id === p.targetId))) invalid('待修改规则不在适用规则中');
    }
  }
  return proposals;
}
async function learningSettings(db) {
  const row = await db('la_settings').where({ key: 'contract_learning' }).first();
  return { enabled: row?.value?.enabled === true, enabledAt: row?.value?.enabledAt || null, updatedAt: row?.updated_at || null,catalogEnabled:config.learningCatalog.enabled };
}
async function makeSnapshot(db, run, classification) {
  let rulePacks = (config.learningCatalog.enabled?await require('./review-defaults').reviewPacks(db):await db('la_rule_versions').where({ state: 'published' })).filter(p => applicable(p.scope, classification));
  if(config.learningCatalog.enabled){const matched=await require('./rules').matchRules(db,classification,rulePacks);rulePacks=rulePacks.filter(p=>matched.packs.some(m=>m.id===p.id));}
  const skillPacks = (await publishedSkills(db)).filter(p => p.scope.level === 'common' || p.scope.typeIds?.includes(classification.typeId));
  return { typeId: classification.typeId, classification, rulePacks, skillPacks, background: run.snapshot?.background || {}, model: null, promptVersion: config.learningCatalog.enabled?'learning-2.0-catalog':'learning-1.2-role-aware' };
}
async function enqueueLearning(db, contract, run, decision, actor) { fail(410, 'REVIEW_ENGINE_RETIRED', '旧规则分批审查及经验发布执行器已删除，请使用 Agent 会话'); }
async function buildSource(db, task, { parser = parseDocument, convert } = {}) {
  const decision = await requireTaskConfirmation(db, task);
  const contract = await db('la_contracts').where({ id: task.contract_id }).first();
  const version = await db('la_versions').where({ id: task.version_id }).first();
  if (!decision || !contract || !version || decision.version_id !== version.id || decision.review_id !== task.review_id || version.contract_id !== contract.id) fail(409, 'LEARNING_SOURCE', '法务确认的文件版本不可核实');
  const run = await db('la_reviews').where({ id: task.review_id, contract_id: task.contract_id }).first();
  if (run?.snapshot?.jointGroup) return buildJointSource(db, task, decision, contract, run, { parser, convert });
  const readDocument = async v => {
    if (!v.parsed && needsConversion(v.filename)) v = await ensureConverted(db, v, { convert });
    const parsed = v.parsed || (needsConversion(v.filename) ? await parseConverted(v, parser) : await parser(await storage.read(v.storage_key), v.filename));
    if (!v.parsed) await persistDocument(db, v, parsed);
    return { id: v.id, hash: v.sha256, versionNo: v.version_no, filename: v.filename, blocks: parsed.blocks, warnings: parsed.warnings || [], requiresHumanVerification: !!parsed.requiresHumanVerification };
  };
  const current = await readDocument(version);
  let previous = null, previousFindings = [], comparison = 'no_previous_version';
  // Use the actual upload parent, even if it was never reviewed in this app.
  // An older reviewed version must not silently replace this baseline.
  if (version.parent_id && version.parent_id !== version.id) {
    const old = await db('la_versions').where({ id: version.parent_id, contract_id: task.contract_id, kind: 'contract' }).first();
    if (old) {
      try { previous = await readDocument(old); comparison = 'previous_version'; }
      catch { comparison = 'ancestor_unreadable'; }
    } else comparison = 'ancestor_unavailable';
    if (previous) {
      const reviews = await db('la_reviews').where({ version_id: old.id }).orderBy('created_at', 'desc');
      for (const review of reviews) {
        const findings = await db('la_findings').where({ review_id: review.id }).whereNotNull('disposition');
        if (!findings.length) continue;
        previousFindings = findings.map(f => ({ ...f, versionId: old.id })); comparison = 'reviewed_ancestor';
        break;
      }
    }
  }
  const findings = [...(await db('la_findings').where({ review_id: task.review_id })).map(f => ({ ...f, versionId: version.id })), ...previousFindings].map(f => ({ id: f.id, reviewId: f.review_id, versionId: f.versionId, ruleId: f.rule_id, title: f.title, evidence: f.evidence, reason: f.reason, suggestion: f.suggestion, disposition: f.disposition }));
  const documents = [current, ...(previous ? [previous] : [])], changes = compareDocuments(current, previous);
  const entity = task.snapshot.background.ourEntity;
  const partyNames = documents.flatMap(d => d.blocks).flatMap(b => [...b.text.matchAll(/[\p{Script=Han}A-Za-z0-9（）()·]{3,80}(?:有限责任公司|股份有限公司|有限公司|集团公司)/gu)].map(m => m[0].replace(/^(?:甲方|乙方|丙方|供方|需方|采购方|供应商)/u, '')));
  return { decision: { id: decision.id, outcome: decision.outcome, reason: decision.reason, conditions: decision.conditions },
    contract: { id: contract.id, number: contract.number }, documents, comparison, findings, comparisonGroups: changes.groups, comparisonSummary: changes.summary,
    restrictedTerms: restrictedNames([entity, contract.number, contract.title, ...partyNames]) };
}
async function buildJointSource(db, task, decision, contract, run, options) {
  const manifest = decision.materials_snapshot;
  if (!manifest || manifest.hash !== run.snapshot.jointGroup.hash) fail(409, 'LEARNING_SOURCE', '结论绑定的整组材料快照不可核实');
  const documents = [], documentPairs = [], restrictedTerms = [contract.number, contract.title, task.snapshot.background.ourEntity].filter(Boolean);
  for (const entry of manifest.documents) {
    const source = await require('./joint-intake').readDocument(db, entry, options);
    const v = await db('la_versions').where({ id: entry.versionId }).first();
    const current = { ...source, id: entry.versionId, hash: entry.sha256, versionNo: v.version_no };
    let previous = null, comparison = 'no_previous_version';
    if (v.parent_id) {
      const old = await db('la_versions').where({ id: v.parent_id, contract_id: entry.contractId, kind: 'contract' }).first();
      if (old) try { const parsed = await require('./joint-intake').readDocument(db, { ...entry, versionId: old.id, sha256: old.sha256, filename: old.filename }, options); previous = { ...parsed, id: old.id, hash: old.sha256, versionNo: old.version_no }; comparison = 'previous_version'; } catch { comparison = 'ancestor_unreadable'; }
      else comparison = 'ancestor_unavailable';
    }
    const changes = compareDocuments(current, previous);
    documentPairs.push({ documentId: entry.documentId, role: entry.role, current, previous, comparison, ...changes });
    documents.push(current, ...(previous ? [previous] : []));
  }
  for (const d of documents) for (const b of d.blocks) for (const m of b.text.matchAll(/[\p{Script=Han}A-Za-z0-9（）()·]{3,80}(?:有限责任公司|股份有限公司|有限公司|集团公司)/gu)) restrictedTerms.push(m[0].replace(/^(?:甲方|乙方|丙方|供方|需方|采购方|供应商)/u, ''));
  const findings = (await db('la_findings').where({ review_id: run.id })).map(f => ({ id: f.id, ruleId: f.rule_id, title: f.title, evidence: f.evidence, reason: f.reason, suggestion: f.suggestion, documentSuggestions: f.document_suggestions, disposition: f.disposition }));
  const summary = documentPairs.reduce((sum, p) => ({ complete: sum.complete && p.summary.complete, coarse: sum.coarse || p.summary.coarse, changed: sum.changed + p.summary.changed, added: sum.added + p.summary.added, removed: sum.removed + p.summary.removed, modified: sum.modified + p.summary.modified }), { complete: true, coarse: false, changed: 0, added: 0, removed: 0, modified: 0 });
  return { decision: { id: decision.id, outcome: decision.outcome, reason: decision.reason, conditions: decision.conditions }, contract: { id: contract.id, number: contract.number }, documents, documentPairs, findings, comparison: 'joint_documents_same_file_versions', comparisonSummary: summary, jointGroup: manifest, jointRelations: run.snapshot.jointRelations, restrictedTerms: restrictedNames(restrictedTerms) };
}
function sourceChunks(source) {
  if (!source.documentPairs) return learningChunks(source.documents[0], source.documents[1], source.comparisonGroups ? { groups: source.comparisonGroups, summary: source.comparisonSummary } : undefined);
  const parts = source.documentPairs.flatMap(p => learningChunks(p.current, p.previous, { groups: p.groups, summary: p.summary }).map(part => part.map(b => ({ ...b, filename: p.current.filename, role: p.role }))));
  // Keep the evidence of each cross-file human disposition in one request.
  // Use exact cited text to bound input while retaining its original paragraph ID.
  for (const f of source.findings.filter(f => f.disposition && new Set(f.evidence.map(e => e.versionId)).size > 1)) {
    const blocks = f.evidence.map(e => ({ id: `${e.versionId}:${e.blockId}`, sourceBlockId: e.blockId, versionId: e.versionId, text: e.quote, side: 'confirmed', change: 'cross_file_evidence', filename: source.documents.find(d => d.id === e.versionId)?.filename }));
    parts.push(...require('./parser').chunks({ blocks }, 16000));
  }
  return parts;
}
async function processLearning(db, id, { gateway, parser, convert } = {}) { fail(410, 'REVIEW_ENGINE_RETIRED', '旧规则分批审查及经验发布执行器已删除，请使用 Agent 会话'); }
async function dependencyRule(db,user,task,p,depth=0){
  if(!p||p.kind!=='rule'||depth>3)fail(409,'SKILL_RULE_REQUIRED','关联规则未就绪，请先审核规则建议');
  if(p.state==='duplicate'){
    const parts=(p.duplicateOf||'').split(':');
    if(parts[0]==='pending'){const stored=await db('la_learning_tasks').where({id:parts[1]}).first();if(!stored)fail(409,'SKILL_RULE_REQUIRED','关联规则建议已变化');await accessible(db,user,stored.contract_id);const other=activeTask(stored);return dependencyRule(db,user,other,other.proposals.find(p=>p.id===parts[2]),depth+1);}
    if(parts[0]==='rule'){const v=await db('la_rule_versions').where({pack_id:parts[1],state:'published'}).first(),rule=v?.rules.find(r=>r.id===parts.slice(2).join(':'));if(rule)return {version:v,rule};}
    fail(409,'SKILL_RULE_REQUIRED','已覆盖规则已变化，请重新整理核对');
  }
  if(p.state!=='adopted')fail(409,'SKILL_RULE_REQUIRED','请先采纳该技能依赖的规则修改建议');
  const version=await db('la_rule_versions').where({id:p.draftVersionId}).first(),rule=version?.rules.find(r=>r.id===(p.adoptedItemId||p.ruleId));
  if(!rule)fail(409,'SKILL_RULE_REQUIRED','依赖规则条目不存在');return {version,rule};
}
async function adoptProposal(db, user, taskId, proposalId, input) { fail(410, 'REVIEW_ENGINE_RETIRED', '旧规则分批审查及经验发布执行器已删除，请使用 Agent 会话'); }
function publicTask(task) {
  const { source, catalog_overlay, generation_details, ...value } = task;
  const versionInfo = document => document ? { id: document.id, versionNo: document.versionNo, filename: document.filename } : null;
  return { ...value, categoryName:findType(task.snapshot.typeId)?.categoryName||'待确认分类', compositeName:require('./contract-skills').compositeName(task.snapshot.typeId,task.proposals.filter(p=>p.kind==='skill')), contractTypeName: findType(task.snapshot.typeId)?.name || '对应合同类型', sourceContext: source ? {
    decision: source.decision, comparison: source.comparison, findings: source.findings,
    currentVersion: versionInfo(source.documentPairs?.[0]?.current || source.documents[0]), previousVersion: versionInfo(source.documentPairs ? source.documentPairs[0]?.previous : source.documents[1]),
    documentPairs: source.documentPairs?.map(p => ({ documentId: p.documentId, role: p.role, currentVersion: versionInfo(p.current), previousVersion: versionInfo(p.previous), comparison: p.comparison, summary: p.summary })),
    comparisonSummary: source.comparisonSummary || compareDocuments(source.documents[0], source.documents[1]).summary,
    warnings: [...new Set(source.documents.flatMap(d => d.warnings || []))],
  } : null, snapshot: { typeId: task.snapshot.typeId, classification:task.snapshot.classification, model: task.snapshot.model, rulePacks: (task.snapshot.rulePacks || []).map(p => ({ id: p.id, packId: p.pack_id, name: p.name, scope: p.scope, rules: p.rules })), skillPacks: (task.snapshot.skillPacks || []).map(p => ({ id: p.id, name: p.name, scope: p.scope, skills: p.skills })) } };
}
function mountLearningRoutes(r, db) {
  require('./learning-proposals').mountProposalRoutes(r,db);
  require('./learning-reorganizations').mountRoutes(r,db);
  r.get('/learning-settings', requireRole('legal', 'publisher'), wrap(async (req, res) => res.json(await learningSettings(db))));
  r.get('/learning-tasks', requireRole('legal', 'publisher'), wrap(async (req, res) => {
    let query = db('la_learning_tasks as t').leftJoin('la_decisions as d', 'd.id', 't.decision_id').leftJoin('la_users as u', 'u.id', 'd.decided_by').leftJoin('la_versions as v', 'v.id', 't.version_id')
      .whereExists(confirmationQuery(db).select(db.raw('1')).whereColumn('confirmed_decision.id','t.decision_id').whereColumn('confirmed_decision.review_id','t.review_id').whereColumn('confirmed_decision.version_id','t.version_id').whereColumn('confirmed_review.contract_id','t.contract_id'))
      .select('t.*', 'u.display_name as confirmedBy', 'd.created_at as confirmedAt', 'v.version_no as confirmedVersionNo').orderBy('t.created_at', 'desc').limit(100);
    if (req.query.contractId) { const id = z.string().uuid().parse(req.query.contractId); await accessible(db, req.user, id); query.where('t.contract_id', id); }
    const tasks = await query, result = [];
    for (const task of tasks) { const c = await db('la_contracts').where({ id: task.contract_id }).first(); if (c && canRead(req.user, c)) result.push({ ...publicTask(activeTask(task)), contractTitle: c.title }); }
    const ids = [...new Set(result.flatMap(t => t.proposals.map(p => p.draftVersionId).filter(Boolean)))];
    const states = new Map();
    if (ids.length) {
      const rows = await Promise.all(['la_rule_versions', 'la_skill_versions'].map(table => db(table).whereIn('id', ids).select('id', 'state', 'version_no')));
      for (const row of rows.flat()) states.set(row.id, row);
    }
    for (const task of result) task.proposals = task.proposals.map(p => ({ ...p, draftState: states.get(p.draftVersionId)?.state || null }));
    res.json(config.learningCatalog.enabled?await require('./learning-proposals').decorateTasks(db,result):result);
  }));
  r.get('/learning-tasks/:id/changes', requireRole('legal', 'publisher'), wrap(async (req, res) => {
    const task = await db('la_learning_tasks').where({ id: z.string().uuid().parse(req.params.id) }).first();
    if (!task) fail(404, 'LEARNING_NOT_FOUND', '经验任务不存在');
    await accessible(db, req.user, task.contract_id);
    const { offset, limit } = z.object({ offset: z.coerce.number().int().nonnegative().default(0), limit: z.coerce.number().int().min(1).max(50).default(20) }).parse(req.query);
    if (!task.source) fail(409, 'LEARNING_SOURCE', '经验来源尚未准备完成');
    const pair = task.source.documentPairs?.find(p => p.documentId === req.query.documentId) || task.source.documentPairs?.[0];
    const [current, previous] = pair ? [pair.current, pair.previous] : task.source.documents;
    if (pair) return res.json(changePage(current, previous, { groups: pair.groups, summary: pair.summary }, offset, limit));
    const comparison = task.source.comparisonGroups ? { groups: task.source.comparisonGroups, summary: task.source.comparisonSummary } : compareDocuments(current, previous);
    res.json(changePage(current, previous, comparison, offset, limit));
  }));
}
module.exports = { validateExperience, semanticKey, learningSettings, enqueueLearning, makeSnapshot, markChanges, buildSource, processLearning, adoptProposal, mountLearningRoutes,publicTask,sourceChunks,dependencyRule };
