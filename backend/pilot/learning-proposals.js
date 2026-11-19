const { z } = require('zod');
const { requireRole,canRead } = require('./auth');
const { wrap } = require('./errors');
const { findType } = require('./catalog');
const { activeTask } = require('./knowledge-catalog');
const { confirmationQuery } = require('./learning-confirmation');
async function decorateTasks(db,tasks){
  const versions=await db('la_skill_versions').select('id','pack_id','state','skills','scope','origin_contract_id'),rules=await db('la_rule_versions').select('id','pack_id','state','rules','scope');
  const all=[...versions,...rules];return tasks.map(task=>({...task,proposals:task.proposals.map(p=>{
    const candidates=p.kind==='skill'?versions:rules;const original=candidates.find(v=>v.id===p.draftVersionId);const stableId=p.adoptedItemId||(p.kind==='rule'?p.ruleId:original?.skills.find(item=>(item.sourceIds||[]).includes(task.id)&&item.title===p.title&&item.method===p.method)?.id||p.targetId);
    const current=candidates.find(v=>v.state==='published'&&(p.scope==='common'?v.scope.level==='common':v.scope.level==='type'&&v.scope.typeIds?.includes(task.snapshot.typeId))&&(v.skills||v.rules).some(item=>
      stableId?item.id===stableId:p.kind==='rule'?item.id===p.ruleId: (item.sourceIds||[]).includes(task.id)&&item.title===p.title&&item.method===p.method));
    return {...p,isComposite:!!original?.origin_contract_id,draftState:current&&p.state==='adopted'?'published':all.find(v=>v.id===p.draftVersionId)?.state||null,...(current&&p.state==='adopted'?{effectiveVersionId:current.id}: {})};
  })}));
}
async function visibleTasks(db,user){
 const rows=await db('la_learning_tasks as t').join('la_contracts as c','c.id','t.contract_id').leftJoin('la_decisions as d','d.id','t.decision_id').leftJoin('la_users as u','u.id','d.decided_by').leftJoin('la_versions as v','v.id','t.version_id')
  .whereExists(confirmationQuery(db).select(db.raw('1')).whereColumn('confirmed_decision.id','t.decision_id').whereColumn('confirmed_decision.review_id','t.review_id').whereColumn('confirmed_decision.version_id','t.version_id').whereColumn('confirmed_review.contract_id','t.contract_id'))
  .select('t.*','c.title as contractTitle','c.department','c.submitter_id','c.reviewer_id','u.display_name as confirmedBy','d.created_at as confirmedAt','v.version_no as confirmedVersionNo').orderBy('t.created_at','desc');
 return rows.filter(t=>canRead(user,{...t,id:t.contract_id})).map(activeTask);
}
function mountProposalRoutes(r,db){
 r.get('/learning-proposals',requireRole('legal','publisher'),wrap(async(req,res)=>{
  const q=z.object({kind:z.enum(['skill','rule']).default('skill'),groupBy:z.enum(['contract']).optional(),categoryId:z.string().optional(),typeId:z.string().optional(),tag:z.string().optional(),state:z.string().optional(),contractId:z.string().uuid().optional(),taskId:z.string().uuid().optional(),page:z.coerce.number().int().positive().default(1),limit:z.coerce.number().int().min(1).max(50).default(10)}).parse(req.query);
  const tasks=await decorateTasks(db,await visibleTasks(db,req.user));
  const {publicTask}=require('./learning');
  const items=tasks.flatMap(t=>t.proposals.map(p=>({p,t}))).filter(({p,t})=>p.kind===q.kind&&(!q.taskId||t.id===q.taskId)&&(!q.categoryId||findType(t.snapshot.typeId)?.categoryId===q.categoryId)&&(!q.typeId||t.snapshot.typeId===q.typeId)&&(!q.tag||t.snapshot.classification.tags?.includes(q.tag))&&(!q.contractId||t.contract_id===q.contractId));
  const state=p=>p.state==='adopted'?(p.draftState==='pending'?'reviewing':p.draftState||'adopted'):p.state;
  const counts={};for(const {p}of items)counts[state(p)]=(counts[state(p)]||0)+1;
  const filtered=items.filter(({p})=>!q.state||state(p)===q.state),start=(q.page-1)*q.limit;
  if(q.groupBy==='contract'&&q.kind==='skill'){
    const groups=new Map();
    for(const {t}of filtered){if(!groups.has(t.contract_id))groups.set(t.contract_id,{id:t.contract_id,tasks:[]});const group=groups.get(t.contract_id);if(!group.tasks.some(x=>x.id===t.id))group.tasks.push(publicTask(t));}
    const groupsArray=[...groups.values()];
    return res.json({groupBy:'contract',total:groupsArray.length,checkTotal:filtered.length,page:q.page,limit:q.limit,counts,contracts:[...new Map(tasks.map(t=>[t.contract_id,{id:t.contract_id,title:t.contractTitle}])).values()],items:groupsArray.slice(start,start+q.limit),activities:tasks.filter(t=>!t.proposals.length&&['queued','running','failed','no_change'].includes(t.status)&&(!q.contractId||t.contract_id===q.contractId)&&(!q.taskId||t.id===q.taskId)&&(!q.typeId||t.snapshot.typeId===q.typeId)&&(!q.categoryId||findType(t.snapshot.typeId)?.categoryId===q.categoryId)&&(!q.tag||t.snapshot.classification?.tags?.includes(q.tag))).map(publicTask)});
  }
  res.json({activities:tasks.filter(t=>!t.proposals.length&&['queued','running','failed'].includes(t.status)&&(!q.contractId||t.contract_id===q.contractId)&&(!q.taskId||t.id===q.taskId)).map(publicTask),total:filtered.length,page:q.page,limit:q.limit,counts,contracts:[...new Map(tasks.map(t=>[t.contract_id,{id:t.contract_id,title:t.contractTitle}])).values()],items:filtered.slice(start,start+q.limit).map(({p,t})=>({id:p.id,kind:p.kind,categoryId:findType(t.snapshot.typeId)?.categoryId,typeId:t.snapshot.typeId,tags:t.snapshot.classification.tags||[],task:publicTask({...t,proposals:[p]})}))});
 }));
}
module.exports={decorateTasks,visibleTasks,mountProposalRoutes};
