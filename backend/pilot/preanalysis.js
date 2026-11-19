const {fail,wrap}=require('./errors');
const {accessible}=require('./auth');
const retired=async()=>fail(410,'REVIEW_ENGINE_RETIRED','独立预分析与模板选择已退役，请使用 Agent 会话');
function publicPreanalysis(row){if(!row)return null;const {snapshot,...value}=row;return value;}
function mountPreanalysisRoutes(r,db){r.get('/preanalyses/:id',wrap(async(req,res)=>{const row=await db('la_preanalyses').where({id:req.params.id}).first();if(!row)fail(404,'PREANALYSIS_NOT_FOUND','历史预分析不存在');await accessible(db,req.user,row.contract_id);res.json(publicPreanalysis(row));}));}
module.exports={publicPreanalysis,mountPreanalysisRoutes,enqueuePreanalysis:retired,processPreanalysis:retired,recoverInterruptedPreanalyses:async()=>0,validateSelection:retired};
