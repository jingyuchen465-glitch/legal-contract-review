const { z } = require('zod');
const { fail } = require('./errors');
const unique = items => [...new Map(items.map(x=>[JSON.stringify(x),x])).values()];
const schema=z.object({groups:z.array(z.object({memberKeys:z.array(z.string()).min(1),disposition:z.enum(['new','update','duplicate']),targetId:z.string().optional(),targetPackId:z.string().optional(),existingKey:z.string().optional()})).max(100)});
function mergeGroups(raw,candidates,existing=[]){
  const {groups}=schema.parse(raw),seen=new Set(),aliases=new Map(),outputs=[];
  for(const [i,group]of groups.entries()){
    const members=group.memberKeys.map(key=>{const p=candidates.find(x=>x.key===key);if(!p||seen.has(key))fail(422,'LEARNING_OUTPUT_INVALID','归并候选缺失或被重复使用');seen.add(key);aliases.set(key,'merged:'+i);return p;});
    const first=members[0];if(members.some(p=>p.kind!==first.kind||p.scope!==first.scope))fail(422,'LEARNING_OUTPUT_INVALID','不同种类或范围的建议不能合并');
    let target=group.targetId;
    if(group.disposition==='duplicate'){
      const old=existing.find(p=>p.existingKey===group.existingKey);if(!old||old.kind!==first.kind||old.scope!==first.scope)fail(422,'LEARNING_OUTPUT_INVALID','重复建议缺少有效的同范围已有内容');
    }
    if(group.disposition==='update'&&!existing.some(p=>!p.existingKey?.startsWith('pending:')&&p.id===target&&p.kind===first.kind&&p.scope===first.scope&&(!group.targetPackId||p.packId===group.targetPackId)))fail(422,'LEARNING_OUTPUT_INVALID','补充建议的目标条目不存在');
    if(group.disposition==='new')target=members.length===1?first.targetId:undefined;
    const previous=group.disposition==='update'?existing.find(p=>p.id===target&&(!group.targetPackId||p.packId===group.targetPackId)):null;
    const content=previous?[previous,...members]:members;
    const text=field=>unique((['method','instruction'].includes(field)?content:members).map(p=>p[field]).filter(Boolean)).join('\n\n');
    outputs.push({...first,key:'merged:'+i,targetId:target,targetPackId:group.targetPackId||first.targetPackId,
      title:first.title,reason:text('reason'),method:text('method'),instruction:text('instruction'),
      conditions:unique(content.flatMap(p=>p.conditions||[])),exclusions:unique(content.flatMap(p=>p.exclusions||[])),examples:unique(content.flatMap(p=>p.examples||[])),
      evidence:unique(members.flatMap(p=>p.evidence)),findingIds:unique(members.flatMap(p=>p.findingIds)),dependsOn:unique(members.flatMap(p=>p.dependsOn)),
      mergedFrom:group.memberKeys,operation:group.disposition==='update'||target?'update':'add',...(group.disposition==='duplicate'?{state:'duplicate',duplicateOf:group.existingKey}:{}),
    });
  }
  if(seen.size!==candidates.length)fail(422,'LEARNING_OUTPUT_INVALID','全文归并遗漏候选检查点');
  for(const p of outputs)p.dependsOn=unique(p.dependsOn.map(key=>{const mapped=aliases.get(key)||(key.startsWith('resolved:')?key:null);if(!mapped)fail(422,'LEARNING_OUTPUT_INVALID','归并后规则依赖丢失');return mapped;}));
  return outputs;
}
function existingItems(snapshot,pending=[]){return [
  ...snapshot.skillPacks.flatMap(p=>p.skills.map(s=>({...s,kind:'skill',scope:p.scope.level,packId:p.pack_id,existingKey:'skill:'+p.pack_id+':'+s.id}))),
  ...snapshot.rulePacks.flatMap(p=>p.rules.map(r=>({...r,kind:'rule',scope:p.scope.level,packId:p.pack_id,existingKey:'rule:'+p.pack_id+':'+r.id}))),...pending];}
async function consolidate(candidates,snapshot,gateway,trace,pending=[]){
  if(!candidates.length)return {proposals:[],groups:[]};
  const existing=existingItems(snapshot,pending);
  if(!gateway.consolidate) return {proposals:candidates,groups:null}; // Custom deterministic adapters retain every candidate.
  const input={classification:snapshot.classification,candidates,existing};
  const validate=raw=>{mergeGroups(raw,candidates,existing);return raw;};
  const raw=await gateway.consolidate(input,trace,validate);return {proposals:mergeGroups(raw,candidates,existing),groups:raw.groups};
}
module.exports={mergeGroups,existingItems,consolidate};
