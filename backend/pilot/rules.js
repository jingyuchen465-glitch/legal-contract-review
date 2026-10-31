const { randomUUID } = require('node:crypto');
const { z } = require('zod');
const { findType } = require('./catalog');
const { fail } = require('./errors');
const scopeSchema = z.object({ level: z.enum(['common', 'category', 'type', 'tag', 'template']), categoryIds: z.array(z.string()).optional(), typeIds: z.array(z.string()).optional(), tags: z.array(z.string()).optional() });
const ruleSchema = z.object({ id: z.string().min(1).max(100), title: z.string().min(1).max(200), instruction: z.string().min(1).max(10000), severity: z.enum(['high', 'medium', 'low']), mandatory: z.boolean().default(true), tags: z.array(z.string()).optional() });
const packSchema = z.object({ name: z.string().min(1).max(200), scope: scopeSchema, rules: z.array(ruleSchema).min(1), knowledge: z.array(z.object({ id: z.string().min(1), title: z.string().min(1), content: z.string().min(1).max(20000), source: z.string().min(1), effectiveDate: z.string().min(1) })).default([]) });
function applicable(scope, classification) {
  const type = findType(classification.typeId);
  return scope.level === 'common' || scope.level === 'category' && scope.categoryIds?.includes(type?.categoryId) || ['type', 'template'].includes(scope.level) && scope.typeIds?.includes(classification.typeId) || scope.level === 'tag' && scope.tags?.some(t => classification.tags.includes(t));
}
async function matchRules(db, classification, publishedPacks, { mode = 'formal' } = {}) {
  const type = findType(classification.typeId); if (!type) fail(422, 'UNKNOWN_CONTRACT_TYPE', '无法确定合同类型，请法务核实分类后重新预审');
  const packs = (publishedPacks || await db('la_rule_versions').where({ state: 'published' }).orderBy('published_at', 'desc')).filter(p => p.state === (mode === 'trial' ? 'example' : 'published') && applicable(p.scope, classification));
  if (!packs.some(p => p.scope.level === 'type' && p.scope.typeIds?.includes(type.id))) fail(422, 'NO_PUBLISHED_RULES', '此合同类型尚无已发布专项规则，请法务确认并发布');
  const rules = [], seen = new Set(), knowledge = [];
  for (const p of packs) {
    for (const r of p.rules) { if (seen.has(r.id)) fail(422, 'RULE_CONFLICT', `适用规则 ID ${r.id} 冲突，请法务处理`); seen.add(r.id); rules.push({ ...r, packVersionId: p.id }); }
    for (const k of p.knowledge) { if (knowledge.some(x => x.id === k.id && JSON.stringify(x) !== JSON.stringify(k))) fail(422, 'KNOWLEDGE_CONFLICT', '依据 ID 冲突，请法务处理'); if (!knowledge.some(x => x.id === k.id)) knowledge.push(k); }
  }
  return { packs: packs.map(p => ({ id: p.id, packId: p.pack_id, version: p.version_no, name: p.name })), rules, knowledge };
}
async function catalogWithAvailability(db) {
  const { catalog } = require('./catalog');
  const { hasExample } = require('./seeds');
  const published = await db('la_rule_versions').where({ state: 'published' }).select('scope');
  return catalog.map(category => ({ ...category, types: category.types.map(type => ({ ...type, reviewEnabled: published.some(pack => pack.scope.level === 'type' && pack.scope.typeIds?.includes(type.id)), trialAvailable: hasExample(type.id) })) }));
}
async function createDraft(db, packId, input, actorId) {
  const parsed = packSchema.parse(input);
  if (new Set(parsed.rules.map(r => r.id)).size !== parsed.rules.length) fail(400, 'RULE_CONFLICT', '同一规则包不能有重复规则 ID');
  const last = await db('la_rule_versions').where({ pack_id: packId }).max('version_no as version').first();
  const current = await db('la_rule_versions').where({ pack_id: packId, state: 'published' }).first();
  const row = { id: randomUUID(), pack_id: packId, version_no: Number(last?.version || 0) + 1, name: parsed.name, scope: JSON.stringify(parsed.scope), rules: JSON.stringify(parsed.rules), knowledge: JSON.stringify(parsed.knowledge), created_by: actorId, base_version_id: current?.id || null };
  return (await db('la_rule_versions').insert(row).returning('*'))[0];
}
module.exports = { matchRules, createDraft, applicable, packSchema, catalogWithAvailability };
