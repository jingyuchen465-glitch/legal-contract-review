// Historical rule-number evaluations remain readable; new evaluations use human risks/evidence.
const {score}=require('./agent/evaluation');
async function processEvaluation(db,id){await db('la_evaluations').where({id}).whereIn('status',['queued','running']).update({status:'failed',result:JSON.stringify({code:'REVIEW_ENGINE_RETIRED',message:'旧规则编号评测已退役，请使用 Agent 风险与证据评测。'}),updated_at:db.fn.now()});}
module.exports={processEvaluation,score};
