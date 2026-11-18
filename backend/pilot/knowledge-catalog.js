const { createHash } = require('node:crypto');
const { fail } = require('./errors');
const { config } = require('./config');
const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a],[b]) => a.localeCompare(b))) : v);
const signature = item => createHash('sha256').update(canonical(Object.fromEntries(Object.entries(item).filter(([k]) => !['sourceIds','sources','requiredRules'].includes(k))))).digest('hex');
function cumulativeItems(base = [], incoming = [], removedIds = []) {
  const removed = new Set(removedIds), map = new Map(base.filter(x => !removed.has(x.id)).map(x => [x.id, structuredClone(x)]));
  if (incoming.some(x => removed.has(x.id))) fail(400,'ITEM_OPERATION_CONFLICT','同一条目不能同时保留和停用');
  if (removedIds.some(id => !base.some(x => x.id === id))) fail(409,'ITEM_NOT_FOUND','待停用条目已变化，请刷新核对');
  for (const item of incoming) { const old = map.get(item.id); map.set(item.id, { ...old, ...item, ...(old?.sourceIds ? {sourceIds:[...new Set([...old.sourceIds,...(item.sourceIds||[])])]} : {}) }); }
  return [...map.values()];
}
function itemChanges(base = [], next = []) {
  const map = new Map(base.map(x=>[x.id,x])), ids = new Set(next.map(x=>x.id));
  return { retained: next.filter(x=>map.has(x.id)&&signature(x)===signature(map.get(x.id))).length,
    added:next.filter(x=>!map.has(x.id)).length, updated:next.filter(x=>map.has(x.id)&&signature(x)!==signature(map.get(x.id))).length,
    removed:base.filter(x=>!ids.has(x.id)).map(x=>x.id) };
}
function assertCumulativePublication(base, next, changes) {
  const missing=(base||[]).filter(x=>!next.some(n=>n.id===x.id)).map(x=>x.id);
  if(missing.some(id=>!changes?.removed?.includes(id)))fail(409,'UNCONFIRMED_REMOVAL','草稿遗漏当前生效条目，请重新保存并明确确认停用清单');
}
function applies(item, classification) {
  const scope=item.applicability, tags=classification.tags||[];
  if(scope?.anyTags?.length&&!scope.anyTags.some(t=>tags.includes(t)))return false;
  if(scope?.excludeTags?.some(t=>tags.includes(t)))return false;
  // Historic warehouse inventory checks describe an operator's service, not a landlord's lease.
  if(!scope&&classification.typeId==='warehouse'&&tags.some(t=>['场地租赁','转租'].includes(t))&&!tags.includes('仓储服务')&&/(^|\/)inventory$/.test(item.id))return false;
  return true;
}
function publicVersion(row, all = []) {
  const next=all.find(x=>x.base_version_id===row.id&&['published','retired'].includes(x.state));
  return {...row, displayState: row.state==='retired'&&(row.state_reason==='superseded'||(!row.state_reason&&next))?'historical':row.state,
    replacedById:row.replaced_by_id||next?.id||null};
}
function activeTask(task) {
  if(!config.learningCatalog.enabled||!task.catalog_overlay)return task;
  return {...task, proposals:task.catalog_overlay.proposals, snapshot:task.catalog_overlay.snapshot, classificationMigrated:true};
}
function proposalUpdate(task, proposals) {
  return task.catalog_overlay&&config.learningCatalog.enabled?{catalog_overlay:JSON.stringify({...task.catalog_overlay,proposals})}:{proposals:JSON.stringify(proposals)};
}
function skillBatches(packs, limit=20, maxChars=24000) {
  const groups=[];let batch=[],length=0,count=0;
  for(const pack of packs)for(const skill of pack.skills){const size=JSON.stringify(skill).length;
    if(count&&(count>=limit||length+size>maxChars)){groups.push(batch);batch=[];count=0;length=0;}
    let target=batch.find(p=>p.id===pack.id);if(!target){target={...pack,skills:[]};batch.push(target);}target.skills.push(skill);count++;length+=size;
  }
  if(count)groups.push(batch);
  const entryOnly=packs.filter(p=>p.fileBundle&&!p.skills.length);
  if(!groups.length)groups.push([]);
  groups[0].push(...entryOnly);
  return groups;
}
module.exports={signature,cumulativeItems,itemChanges,assertCumulativePublication,applies,publicVersion,activeTask,proposalUpdate,skillBatches};
