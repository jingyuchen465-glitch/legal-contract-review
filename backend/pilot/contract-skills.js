const { randomUUID, createHash } = require('node:crypto');
const { z } = require('zod');
const { fail, wrap } = require('./errors');
const { requireRole, accessible, assertRevision, audit } = require('./auth');
const { catalog, findType } = require('./catalog');
const { activeTask, proposalUpdate, signature } = require('./knowledge-catalog');
const { defaultEntry, entryPack, materialize, readFiles } = require('./skill-files');
const { requireTaskConfirmation } = require('./learning-confirmation');
const normalized = value => String(value || '').replace(/\s+/gu, '').toLowerCase();
const methodKey = p => JSON.stringify([[p.method,p.conditions,p.exclusions,p.examples].map(v=>Array.isArray(v)?v.map(normalized):normalized(v)),p.applicability||null,p.requiredRules||[]]);
function compositeName(typeId, proposals) {
  const text = proposals.map(p => p.title).join('、');
  const topics = ['付款','交付','验收','质量','租赁','转租','费用','续约','知识产权','数据','违约'].filter(t=>text.includes(t)).slice(0,3);
  return `${findType(typeId)?.name || '合同'}${topics.length?'·'+topics.join('与'):''}综合审查技能`.slice(0,200);
}
function mergeChecks(base, proposals, taskId, classification) {
  const result = structuredClone(base || []);
  for (const p of proposals) {
    p.applicability ||= {anyTags:(classification.tags||[]).filter(t=>['场地租赁','转租','仓储服务'].includes(t)),excludeTags:[]};
    const old = result.find(s => s.id === p.targetId || methodKey(s) === methodKey(p));
    const item = { id:old?.id || 'check-' + createHash('sha256').update(taskId+':'+p.id).digest('hex').slice(0,32),
      title:p.title,method:p.method,conditions:p.conditions,exclusions:p.exclusions,examples:p.examples,
      sourceIds:[...new Set([...(old?.sourceIds||[]),taskId])],reason:p.reason,
      evidence:[...new Map([...(old?.evidence||[]),...(p.evidence||[])].map(e=>[JSON.stringify(e),e])).values()],
      findingIds:[...new Set([...(old?.findingIds||[]),...(p.findingIds||[])])],
      requiredRules:p.requiredRules || old?.requiredRules || [],
      applicability:p.applicability };
    if(old)result[result.indexOf(old)]=item;else result.push(item);
    p.adoptedItemId=item.id;
  }
  return result;
}
async function createContractDraft(db,user,contractId,input) { fail(410, 'REVIEW_ENGINE_RETIRED', '旧规则分批审查及经验发布执行器已删除，请使用 Agent 会话'); }
const entrySchema=z.object({name:z.string().trim().min(1).max(200),description:z.string().trim().min(1).max(2000),body:z.string().trim().min(1).max(16000)});
function mountContractSkillRoutes(r,db){
  r.get('/skill-entries',requireRole('legal','publisher'),wrap(async(req,res)=>{
    const rows=await db('la_skill_entry_versions').orderBy('version_no','desc');
    res.json(['common',...catalog.map(c=>c.id)].map(key=>({key,defaults:defaultEntry(key),versions:rows.filter(r=>r.entry_key===key)})));
  }));
  r.get('/skill-pack-versions/:id/files',requireRole('legal','publisher'),wrap(async(req,res)=>{
    const p=await db('la_skill_versions').where({id:z.string().uuid().parse(req.params.id)}).first();if(!p)fail(404,'SKILL_NOT_FOUND','技能版本不存在');
    const key=p.scope.level==='common'?'common':findType(p.scope.typeIds[0]).categoryId;
    const entry=await db('la_skill_entry_versions').where({entry_key:key,state:'published'}).first();
    const commonEntry=await db('la_skill_entry_versions').where({entry_key:'common',state:'published'}).first();
    const bundle=p.file_bundle||await materialize(p,entry,commonEntry);res.json({bundle,contents:await readFiles(bundle)});
  }));
  r.get('/skill-pack-versions/:id/bundle',requireRole('legal','publisher'),wrap(async(req,res)=>{
    const p=await db('la_skill_versions').where({id:z.string().uuid().parse(req.params.id)}).first();if(!p)fail(404,'SKILL_NOT_FOUND','技能版本不存在');
    const key=p.scope.level==='common'?'common':findType(p.scope.typeIds[0]).categoryId;
    const entry=await db('la_skill_entry_versions').where({entry_key:key,state:'published'}).first();
    const commonEntry=await db('la_skill_entry_versions').where({entry_key:'common',state:'published'}).first();
    const bundle=p.file_bundle||await materialize(p,entry,commonEntry),contents=await readFiles(bundle),zip=new (require('adm-zip'))();
    for(const [name,content]of Object.entries(contents))zip.addFile(`contract-review-${key}/${name}`,Buffer.from(content));
    res.type('application/zip').attachment(`${p.pack_id}-v${p.version_no}.zip`).send(zip.toBuffer());
  }));
}
module.exports={compositeName,mergeChecks,createContractDraft,mountContractSkillRoutes};
