const {randomUUID,createHash}=require('node:crypto');
const {z}=require('zod');
const {config}=require('./config');
const {findType}=require('./catalog');
const {requireRole,accessible,canRead,audit,assertRevision}=require('./auth');
const {wrap,fail}=require('./errors');
const {activeTask,cumulativeItems,itemChanges,signature}=require('./knowledge-catalog');
const {requireConfirmation,requireTaskConfirmation,confirmedContracts}=require('./learning-confirmation');
const currentConfirmation=(db,c)=>requireConfirmation(db,{contractId:c.id,reviewId:c.current_review_id,versionId:c.current_version_id});
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const assertEnabled=()=>{if(!config.learningCatalog.enabled)fail(409,'CATALOG_DISABLED','分类整理暂未开放');};
async function enqueue(db,user,c) { fail(410, 'REVIEW_ENGINE_RETIRED', '旧规则分批审查及经验发布执行器已删除，请使用 Agent 会话'); }
async function sourceDocument(db,entry){
  const v=await db('la_versions').where({id:entry.versionId,contract_id:entry.contractId,sha256:entry.sha256}).first();if(!v)fail(409,'REORGANIZATION_STALE','历史文件版本无法核实');
  const storage=require('./storage'),buffer=await storage.read(v.storage_key);if(storage.sha256(buffer)!==entry.sha256)fail(409,'FILE_INTEGRITY','原文件哈希校验未通过');
  let parsed=v.parsed;if(!parsed){const parser=require('./parser').parseDocument;if(require('./file-formats').needsConversion(v.filename)){if(!v.conversion?.artifacts)fail(422,'CONVERSION_REQUIRED','请先完成该文件的格式转换，再生成分类整理候选');parsed=await require('./conversion').parseConverted(v,parser);}else parsed=await parser(buffer,v.filename,{detectMixed:true});}
  if(!parsed.blocks?.some(b=>b.text?.trim()))fail(422,'DOCUMENT_EMPTY','源文件未识别到正文，请补件后重新整理');
  return {...entry,blocks:parsed.blocks,warnings:parsed.warnings||[],requiresHumanVerification:!!parsed.requiresHumanVerification};
}
async function processReorganization(db,id,{gateway}={}) { fail(410, 'REVIEW_ENGINE_RETIRED', '旧规则分批审查及经验发布执行器已删除，请使用 Agent 会话'); }
async function apply(db,user,id,input) { fail(410, 'REVIEW_ENGINE_RETIRED', '旧规则分批审查及经验发布执行器已删除，请使用 Agent 会话'); }
function mountRoutes(r,db){
 r.get('/learning-reorganizations',requireRole('legal','publisher'),wrap(async(req,res)=>{
  const eligible=await confirmedContracts(db).pluck('c.id');
  const rows=await db('la_learning_reorganizations as r').join('la_contracts as c','c.id','r.contract_id')
   .join('la_decisions as d',function(){this.on('d.review_id','=','c.current_review_id').on('d.version_id','=','r.version_id');})
   .join('la_users as u','u.id','d.decided_by').join('la_versions as v','v.id','d.version_id')
   .whereIn('c.id',eligible).whereColumn('r.version_id','c.current_version_id')
   .select('r.*','c.title as contractTitle','c.department','c.submitter_id','c.reviewer_id','u.display_name as confirmedBy','d.created_at as confirmedAt','v.version_no as confirmedVersionNo').orderBy('r.created_at','desc');
  res.json(rows.filter(row=>canRead(req.user,{...row,id:row.contract_id})).map(({baseline,...row})=>row));
 }));
}
module.exports={enqueue,processReorganization,apply,mountRoutes};
