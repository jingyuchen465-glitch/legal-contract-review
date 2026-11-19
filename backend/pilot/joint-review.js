const { createHash } = require('node:crypto');
const { z } = require('zod');
const { chunks } = require('./parser');
const { fail } = require('./errors');
const categories = ['amendments', 'amounts_terms', 'precedence'];
const rules = [
  { id: 'joint/amendments', title: '补充条款对照', severity: 'medium', instruction: '对照原协议及补充约定，逐项说明替换、新增、删除的条款和影响。不能把两个独立文件当作前后版本；无法确认对应条款、签署或生效条件时标记 uncertain。' },
  { id: 'joint/amounts_terms', title: '跨文件金额与期限核对', severity: 'high', instruction: '对照金额、币种、含税口径、计价范围、付款条件、履约期限、续约和终止。区分同一事项冲突与明确有效的变更；不得推定汇率、税率、日期或条件。修改建议指明目标文件。' },
  { id: 'joint/precedence', title: '文件适用顺序', severity: 'high', instruction: '引用文件间的变更、优先适用及生效约定，说明具体事项以何约定为准。不能按文件名、上传顺序或日期自动决定。缺乏明确依据、主体范围不匹配或约定互相冲突时标记 uncertain 并请求核实。' },
];
const reference = z.object({ blockId: z.string(), quote: z.string().min(1) });
const factsSchema = z.object({ facts: z.array(z.object({ topic: z.enum(categories), summary: z.string().min(1), evidence: z.array(reference).min(1) })) });
const relationSchema = z.object({ category: z.enum(categories), effect: z.enum(['replace', 'add', 'delete', 'conflict', 'uncertain', 'consistent']), before: z.array(reference), after: z.array(reference), basis: z.array(reference), explanation: z.string().min(1), applicableText: z.string() });
const comparisonSchema = z.object({ checks: z.array(z.unknown()), relations: z.array(relationSchema), suggestions: z.array(z.object({ versionId: z.string().uuid(), text: z.string().min(1) })) });
function schemaFailure(result, message) { const error = new (require('./errors').AppError)(422, 'MODEL_OUTPUT_SCHEMA', message); error.diagnostics = { issues: require('./review-diagnostics').schemaIssues(result.error.issues) }; throw error; }
function validateFacts(raw, blocks) {
  const parsed = factsSchema.safeParse(raw); if (!parsed.success) schemaFailure(parsed, '联合审查文件要素格式无效');
  for (const fact of parsed.data.facts) fact.evidence = require('./model').verifyEvidence(fact.evidence, blocks);
  return parsed.data;
}
function validateComparison(raw, blocks, documents) {
  const parsed = comparisonSchema.safeParse(raw); if (!parsed.success) schemaFailure(parsed, '联合审查对照格式无效');
  const data = parsed.data;
  data.checks = require('./model').validateChecks({ checks: data.checks }, rules, { blocks }, []);
  for (const relation of data.relations) {
    for (const key of ['before', 'after', 'basis']) relation[key] = require('./model').verifyEvidence(relation[key], blocks);
    if (!relation.before.length && !relation.after.length && relation.effect !== 'uncertain') fail(422, 'INVALID_EVIDENCE', '跨文件判断缺少原文引用');
    if (['replace', 'delete', 'conflict'].includes(relation.effect) && (!relation.before.length || !relation.after.length)) fail(422, 'INVALID_EVIDENCE', '变更或冲突必须提供双方原文');
    if (['replace', 'delete', 'conflict'].includes(relation.effect) && !relation.before.some(a => relation.after.some(b => a.blockId.split(':')[0] !== b.blockId.split(':')[0]))) fail(422, 'INVALID_EVIDENCE', '跨文件变更或冲突必须引用不同文件');
    if (relation.category === 'precedence' && relation.effect !== 'uncertain' && !relation.basis.length) fail(422, 'INVALID_EVIDENCE', '文件适用顺序必须有明确条款依据');
  }
  if (categories.some(category => !data.relations.some(r => r.category === category))) fail(422, 'RULE_COVERAGE', '联合审查须说明三类对照结果，包括无法判断的事项');
  if (!blocks.length && data.checks.some(c => c.status !== 'uncertain')) fail(422, 'INVALID_EVIDENCE', '无相关原文时必须标记待确认');
  if (data.suggestions.some(s => !documents.some(d => d.versionId === s.versionId))) fail(422, 'INVALID_EVIDENCE', '修改建议指向了其他文件');
  return data;
}
function namespaced(source) { return source.blocks.map(b => ({ ...b, id: `${source.versionId}:${b.id}`, sourceBlockId: b.id, versionId: source.versionId, filename: source.filename, role: source.role })); }
function evidenceForFile(findings, versionId, mainVersionId = versionId) {
  return (findings || []).filter(f => f.evidence?.some(e => (e.versionId || mainVersionId) === versionId) || !(f.evidence || []).length && (versionId === mainVersionId || f.document_suggestions?.some(s => s.versionId === versionId))).map(f => ({ ...f,
    evidence: (f.evidence || []).filter(e => (e.versionId || mainVersionId) === versionId),
    suggestion: f.document_suggestions?.filter(s => s.versionId === versionId).map(s => s.text).join('\n\n') || f.suggestion,
  }));
}
function mergeChecks(values) {
  const order = { pass: 0, uncertain: 1, fail: 2 }, map = new Map();
  for (const check of values) { const list = map.get(check.ruleId) || []; list.push(check); map.set(check.ruleId, list); }
  return [...map.values()].map(list => {
    const best = [...list].sort((a, b) => order[b.status] - order[a.status] || ({ high: 3, medium: 2, low: 1 }[b.severity] - { high: 3, medium: 2, low: 1 }[a.severity]))[0];
    const relevant = best.status === 'pass' ? list : list.filter(c => c.status !== 'pass');
    return { ...best, reason: [...new Set(relevant.map(c => c.reason))].join('\n\n'), suggestion: [...new Set(relevant.map(c => c.suggestion).filter(Boolean))].join('\n\n'),
      evidence: [...new Map(relevant.flatMap(c => c.evidence).map(e => [JSON.stringify(e), e])).values()], legalRefIds: [...new Set(relevant.flatMap(c => c.legalRefIds))],
      documentSuggestions: [...new Map(relevant.flatMap(c => c.documentSuggestions || []).map(s => [JSON.stringify(s), s])).values()] };
  });
}
async function review(db, snapshot, gateway, trace, batchStore, options = {}) {
  const sources = [];
  for (const entry of snapshot.jointGroup.documents) sources.push(await require('./joint-intake').readDocument(db, entry, options));
  const allBlocks = sources.flatMap(namespaced), byId = new Map(allBlocks.map(b => [b.id, b]));
  const recover = evidence => evidence.map(e => { const b = byId.get(e.blockId); if (!b || !b.text.includes(e.quote)) fail(422, 'INVALID_EVIDENCE', '联合审查引用不属于固定材料'); return { versionId: b.versionId, blockId: b.sourceBlockId, quote: e.quote }; });
  const regularBlocks = sources.filter(d => ['main', 'supplement'].includes(d.role)).flatMap(namespaced);
  const regular = await gateway.review({ blocks: regularBlocks }, snapshot.rules, snapshot.knowledge, { ...snapshot.background, jointDocuments: snapshot.jointGroup.documents }, trace, batchStore, snapshot.skills || []);
  const checks = regular.checks.map(c => { const evidence = recover(c.evidence); return { ...c, evidence, documentSuggestions: [...new Set(evidence.length ? evidence.map(e => e.versionId) : [sources.find(s => s.role === 'main').versionId])].map(versionId => ({ versionId, text: c.suggestion })) }; }), relations = [];
  let crossBatches = 0; const pairCoverage = [], factCoverage = [];
  if (sources.length > 1) {
    const factsByDocument = [];
    for (const source of sources) {
      const facts = []; let factChunks = 0;
      for (const [index, part] of chunks({ blocks: namespaced(source) }, 12000).entries()) {
        const key = createHash('sha256').update(JSON.stringify(['joint-facts-1', snapshot.jointGroup.hash, snapshot.model, source.versionId, index, part])).digest('hex');
        const cached = await batchStore.load?.(key);
        const data = cached ? validateFacts(cached, part) : validateFacts(await gateway.jointFacts(part, trace), part);
        if (!cached) await batchStore.save?.(key, data, { phase: 'joint_facts', versionId: source.versionId, chunkIndex: index + 1 });
        facts.push(...data.facts); await trace?.({ label: 'joint_facts', versionId: source.versionId, chunkIndex: index + 1 });
        factChunks++;
      }
      // Empty extracted facts still lead to an explicit lack-of-evidence check.
      const ids = new Set(facts.flatMap(f => f.evidence.map(e => e.blockId)));
      factsByDocument.push({ source, parts: chunks({ blocks: namespaced(source).filter(b => ids.has(b.id)) }, 6000) });
      factCoverage.push({ versionId: source.versionId, chunks: factChunks, facts: facts.length, topics: [...new Set(facts.map(f => f.topic))] });
    }
    for (let i = 0; i < factsByDocument.length; i++) for (let j = i + 1; j < factsByDocument.length; j++) {
      const a = factsByDocument[i], b = factsByDocument[j];
      const pair = { versionIds: [a.source.versionId, b.source.versionId], batches: 0, complete: false };
      for (const left of a.parts.length ? a.parts : [[]]) for (const right of b.parts.length ? b.parts : [[]]) {
        const blocks = [...left, ...right], documents = [a.source, b.source].map(({ blocks, ...meta }) => meta);
        const input = { rules, documents, blocks, background: snapshot.background };
        const key = createHash('sha256').update(JSON.stringify(['joint-compare-1', snapshot.jointGroup.hash, snapshot.model, input])).digest('hex');
        const cached = await batchStore.load?.(key);
        const data = validateComparison(cached || await gateway.jointCompare(input, trace), blocks, documents);
        if (!cached) await batchStore.save?.(key, data, { phase: 'joint_compare', documents: documents.map(d => d.versionId) });
        for (const check of data.checks) checks.push({ ...check, title: rules.find(r => r.id === check.ruleId).title, evidence: recover(check.evidence), documentSuggestions: data.suggestions });
        for (const relation of data.relations) relations.push({ ...relation, before: recover(relation.before), after: recover(relation.after), basis: recover(relation.basis) });
        crossBatches++; await trace?.({ label: 'joint_compare', crossBatches });
        pair.batches++;
      }
      pair.complete = true; pairCoverage.push(pair);
    }
  }
  if (sources.length === 1) for (const category of categories) relations.push({ category, effect: 'uncertain', notApplicable: true, before: [], after: [], basis: [], explanation: '本组仅有一份已确认文件，无其他材料可作跨文件对照。此项不适用，不代表已核对未提供的材料。', applicableText: '' });
  return { checks: mergeChecks(checks), relations, sources,
    coverage: { ...regular.coverage, complete: regular.coverage.complete && (sources.length === 1 || crossBatches > 0), totalRules: snapshot.rules.length + (sources.length > 1 ? 3 : 0), checkedRules: snapshot.rules.length + (sources.length > 1 ? 3 : 0),
      documents: sources.map(d => ({ versionId: d.versionId, filename: d.filename, role: d.role, blocks: d.blocks.length, processed: true })), crossDocument: { complete: true, batches: crossBatches, notApplicable: sources.length === 1, categories, facts: factCoverage, pairs: pairCoverage } } };
}
module.exports = { rules, categories, namespaced, validateFacts, validateComparison, mergeChecks, evidenceForFile, review };
