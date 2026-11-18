const { randomUUID } = require('node:crypto');
const { z } = require('zod');
const { catalog, findType } = require('./catalog');
const { fail, wrap } = require('./errors');
const { requireRole, assertRevision, audit, accessible, canRead } = require('./auth');
const { config } = require('./config');
const { signature, cumulativeItems, itemChanges, applies, publicVersion } = require('./knowledge-catalog');
const text = z.string().trim().min(1);
const skillSchema = z.object({ id: text.max(100), title: text.max(200), method: text.max(6000), conditions: z.array(text.max(2000)).max(100).default([]), exclusions: z.array(text.max(2000)).max(100).default([]), examples: z.array(text.max(3000)).max(50).default([]), sourceIds: z.array(z.string().uuid()).default([]), applicability:z.object({anyTags:z.array(text).default([]),excludeTags:z.array(text).default([])}).optional(), requiredRules:z.array(z.object({packId:text,ruleId:text,signature:text})).optional(), reason:z.string().optional(), evidence:z.array(z.object({versionId:z.string().uuid(),blockId:text,quote:text})).optional(), findingIds:z.array(z.string().uuid()).optional() });
const packSchema = z.object({ name: text.max(200), scope: z.object({ level: z.enum(['common', 'type']), typeIds: z.array(z.string()).default([]) }), skills: z.array(skillSchema).min(1) });
function validatePack(input, { composite = false } = {}) {
  const value = packSchema.parse(input);
  if (value.scope.level === 'type' && (value.scope.typeIds.length !== 1 || !findType(value.scope.typeIds[0]))) fail(400, 'SKILL_SCOPE', '专用技能须选择一个目录内合同类型');
  if (value.scope.level === 'common' && value.scope.typeIds.length) fail(400, 'SKILL_SCOPE', '通用技能适用于全部合同，无需选择类型');
  if (new Set(value.skills.map(s => s.id)).size !== value.skills.length) fail(400, 'SKILL_DUPLICATE', '技能条目编号重复');
  if (!config.learningCatalog.enabled && !composite && value.skills.some(s=>s.conditions.length>10||s.exclusions.length>10||s.examples.length>5))fail(400,'SKILL_SIZE','方法中的条件或范例过多');
  if (!config.learningCatalog.enabled && !composite && value.skills.length>20) fail(400,'SKILL_SIZE','单个技能包最多20条方法');
  if (!config.learningCatalog.enabled && !composite && JSON.stringify(value.skills).length > 24000) fail(400, 'SKILL_SIZE', '单个技能包内容不得超过24000字，请精简审查方法与范例');
  return value;
}
const packIdFor = (scope, contractId) => contractId ? 'review-contract-' + contractId : scope.level === 'common' ? 'review-skill-common' : 'review-skill-' + scope.typeIds[0];
function matchSkills(classification, packs = [], rulePacks = []) {
  const ids = new Set(rulePacks.map(p => p.id));
  return packs.filter(p => p.state === 'published' && (p.scope.level === 'common' || p.scope.level === 'type' && p.scope.typeIds?.includes(classification.typeId)) && (config.learningCatalog.enabled || p.origin_contract_id || (p.required_rule_versions || []).every(id => ids.has(id))))
    .sort((a, b) => Number(!!a.entry_only)-Number(!!b.entry_only) || (a.scope.level === 'common' ? 0 : 1) - (b.scope.level === 'common' ? 0 : 1))
    .map(p => {
      const eligible=s=>(!config.learningCatalog.enabled&&!p.origin_contract_id)||(applies(s,classification)&&(s.requiredRules ? s.requiredRules.every(d=>rulePacks.some(r=>(r.packId||r.pack_id)===d.packId&&(r.ruleSignatures?.[d.ruleId]===d.signature||r.rules?.some(x=>x.id===d.ruleId&&signature(x)===d.signature)))):(p.required_rule_versions||[]).every(id=>ids.has(id))));
      return { id: p.id, packId: p.pack_id, version: p.version_no, name: p.name, scope: p.scope, ...(p.entry_only?{entryOnly:true}:{}), ...(p.file_bundle?{fileBundle:p.file_bundle}:{}), ...(p.origin_contract_id?{originContractId:p.origin_contract_id}:{}), skills:p.skills.filter(eligible), excludedSkills:config.learningCatalog.enabled?p.skills.filter(s=>!eligible(s)).map(s=>({id:s.id,title:s.title,reason:applies(s,classification)?'依赖规则已变化或未纳入本次审查，待复核':'不符合本次业务标签'})):[], sources: p.sources || [], requiredRuleVersions: p.required_rule_versions || [] };
    });
}
const skillInput = packs => packs.map(p => ({ versionId: p.id, name: p.name, version: p.version, scope: p.scope, skills: p.skills.map(({ sourceIds, evidence, findingIds, reason, ...item }) => item) }));
async function hydrateDependencies(db, packs) {
  const ids=[...new Set(packs.flatMap(p=>p.required_rule_versions||[]))], rules=ids.length?await db('la_rule_versions').whereIn('id',ids):[];
  for(const p of packs)p.skills=p.skills.map(s=>s.requiredRules?s:{...s,requiredRules:(p.required_rule_versions||[]).flatMap(id=>{const r=rules.find(r=>r.id===id);return r?r.rules.map(x=>({packId:r.pack_id,ruleId:x.id,signature:signature(x)})):[{packId:'missing',ruleId:id,signature:'unresolved'}];})});
  return packs;
}
async function publishedSkills(db) {
  const packs=await db('la_skill_versions').where({ state: 'published' }).orderBy('published_at', 'desc');
  if(config.learningCatalog.enabled)await hydrateDependencies(db,packs);
  const entries=await db('la_skill_entry_versions').where({state:'published'});
  const replacements=packs.flatMap(p=>p.legacy_replacements||[]);
  for(const p of packs){
    if(!p.origin_contract_id)p.skills=p.skills.filter(s=>!replacements.some(r=>r.packId===p.pack_id&&r.itemId===s.id&&r.signature===signature(s)));
    if(p.skills.length){
      const key=p.scope.level==='common'?'common':findType(p.scope.typeIds[0]).categoryId;
      const entry=entries.find(e=>e.entry_key===key);
      const commonEntry=entries.find(e=>e.entry_key==='common');
      if(p.file_bundle)await require('./skill-files').readFiles(p.file_bundle);
      // A newly published entry affects new tasks; queued tasks keep the frozen bundle.
      if(!p.file_bundle||p.file_bundle.entryVersionId!==(entry?.id||null)||p.file_bundle.commonEntryVersionId!==(commonEntry?.id||null))p.file_bundle=await require('./skill-files').materialize(p,entry,commonEntry);
    }
  }
  // Entrypoints are runtime review context, not additional contract skills in the library.
  const {entryPack,materialize}=require('./skill-files');
  const commonEntry=entries.find(e=>e.entry_key==='common');
  for(const key of ['common',...catalog.map(c=>c.id)]){
    const typeIds=key==='common'?[]:catalog.find(c=>c.id===key).types.map(t=>t.id).filter(id=>!packs.some(p=>p.skills.length&&p.scope.level==='type'&&p.scope.typeIds.includes(id)));
    if(key==='common'?packs.some(p=>p.scope.level==='common'&&p.skills.length):!typeIds.length)continue;
    const entry=entries.find(e=>e.entry_key===key),pack=entryPack(key,entry,typeIds);
    pack.file_bundle=await materialize(pack,entry,commonEntry);packs.push(pack);
  }
  return packs;
}
async function createSkillDraft(db, input, actorId, { expectedBase, sources, dependencies, removedIds=[], contractId=null, replacements=[] } = {}) {
  const body = validatePack(input,{composite:!!contractId}), packId = packIdFor(body.scope,contractId);
  await db.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['skill:' + packId]);
  const current = await db('la_skill_versions').where({ pack_id: packId, state: 'published' }).first();
  if(contractId&&await db('la_skill_versions').where({origin_contract_id:contractId}).whereIn('state',['draft','pending']).first())fail(409,'CONTRACT_SKILL_DRAFT_EXISTS','该合同已有待处理综合技能，请先编辑或发布已有草稿');
  if (expectedBase !== undefined && (current?.id || null) !== expectedBase) fail(409, 'SKILL_BASE_CHANGED', '技能已有新版本，请重新整理经验后核对');
  if(config.learningCatalog.enabled||contractId){if(current)await hydrateDependencies(db,[current]);body.skills=cumulativeItems(current?.skills,body.skills,removedIds);await hydrateDependencies(db,[{skills:body.skills,required_rule_versions:dependencies||current?.required_rule_versions||[]}]);}
  const last = await db('la_skill_versions').where({ pack_id: packId }).max('version_no as n').first();
  const [row] = await db('la_skill_versions').insert({ id: randomUUID(), pack_id: packId, version_no: Number(last?.n || 0) + 1, name: body.name,
    scope: JSON.stringify(body.scope), skills: JSON.stringify(body.skills), base_version_id: current?.id || null, created_by: actorId,
    sources: JSON.stringify(sources || current?.sources || []), required_rule_versions: JSON.stringify(dependencies || current?.required_rule_versions || []), ...(contractId?{origin_contract_id:contractId,legacy_replacements:JSON.stringify(replacements.length?replacements:current?.legacy_replacements||[])}:{}), ...(config.learningCatalog.enabled||contractId?{item_changes:JSON.stringify(itemChanges(current?.skills,body.skills))}:{}) }).returning('*');
  return row;
}
function markdown(pack) {
  const lines = [`# ${pack.name}`, '', `版本：${pack.version_no}；状态：${pack.state}`, `范围：${pack.scope.level === 'common' ? '全部合同' : findType(pack.scope.typeIds[0])?.name || pack.scope.typeIds[0]}`, '', '技能提供审查方法，不能覆盖正式规则或作为法律依据。', ''];
  for (const s of pack.skills) {
    lines.push(`## ${s.title}`, '', s.method, '');
    for (const [key, label] of [['conditions', '适用条件'], ['exclusions', '排除条件'], ['examples', '修改范例']]) if (s[key]?.length) lines.push(`### ${label}`, '', ...s[key].map(t => `- ${t}`), '');
    if (s.sourceIds?.length) lines.push(`来源经验任务：${s.sourceIds.join('、')}`, '');
  }
  return lines.join('\n');
}
function mountSkillRoutes(r, db) {
  require('./contract-skills').mountContractSkillRoutes(r,db);
  r.get('/skill-packs', requireRole('legal', 'publisher'), wrap(async (req, res) => {
    const rows=await db('la_skill_versions').orderBy('pack_id').orderBy('version_no','desc');
    const ids=[...new Set(rows.map(p=>p.origin_contract_id).filter(Boolean))],contracts=ids.length?await db('la_contracts').whereIn('id',ids):[];
    res.json(rows.map(p=>({...publicVersion(p,rows),originContractTitle:contracts.find(c=>c.id===p.origin_contract_id&&canRead(req.user,c))?.title||null,skills:p.skills.map(({evidence,findingIds,reason,...s})=>s),changes:itemChanges(rows.find(x=>x.id===p.base_version_id)?.skills,p.skills)})));
  }));
  r.get('/skill-pack-versions/:id/export', requireRole('legal', 'publisher'), wrap(async (req, res) => {
    const row = await db('la_skill_versions').where({ id: z.string().uuid().parse(req.params.id) }).first();
    if (!row) fail(404, 'SKILL_NOT_FOUND', '技能版本不存在');
    res.type('text/markdown; charset=utf-8').attachment(`${row.pack_id}-v${row.version_no}.md`).send(markdown(row));
  }));
  r.get('/skill-pack-versions/:id/sources', requireRole('legal', 'publisher'), wrap(async (req, res) => {
    const row = await db('la_skill_versions').where({ id: z.string().uuid().parse(req.params.id) }).first();
    if (!row) fail(404, 'SKILL_NOT_FOUND', '技能版本不存在');
    const sources = [];
    for (const source of row.sources) {
      try { const c = await accessible(db, req.user, source.contractId); sources.push({ ...source, contractTitle: c.title }); }
      catch (e) { if (e.code !== 'CONTRACT_NOT_FOUND') throw e; }
    }
    res.json(sources);
  }));
}
function preserveProvenance(item,pack,dependencies){
  const old=pack?.skills.find(s=>s.id===item.id);
  return {...item,sourceIds:old?.sourceIds||[],evidence:old?.evidence||[],findingIds:old?.findingIds||[],reason:old?.reason||'',...(dependencies?{requiredRules:old?.requiredRules||[]}:{} )};
}
module.exports = { skillSchema, validatePack, packIdFor, matchSkills, skillInput, publishedSkills, createSkillDraft, markdown, mountSkillRoutes };
