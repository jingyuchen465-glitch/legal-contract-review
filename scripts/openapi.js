const fs=require('node:fs');
const path=require('node:path');
const schemas={
  Background:{type:'object',required:['ourEntity','perspective','purpose'],properties:{ourEntity:{type:'string',maxLength:200},perspective:{type:'string',maxLength:200},purpose:{type:'string',maxLength:3000}}},
  Revision:{type:'integer',minimum:1,description:'从最近一次读取的记录获得；不匹配返回409'},
  Evidence:{type:'object',required:['blockId','quote'],properties:{blockId:{type:'string'},quote:{type:'string',minLength:1}}},
  Rule:{type:'object',required:['id','title','instruction','severity'],properties:{id:{type:'string'},title:{type:'string'},instruction:{type:'string'},severity:{enum:['high','medium','low']},mandatory:{type:'boolean',default:true}}},
  RulePack:{type:'object',required:['name','scope','rules'],properties:{name:{type:'string'},scope:{type:'object'},rules:{type:'array',items:{$ref:'#/components/schemas/Rule'}},knowledge:{type:'array',items:{type:'object',required:['id','title','content','source','effectiveDate']}}}},
  ClassificationGuidance:{type:'object',required:['description'],properties:{description:{type:'string',minLength:1,maxLength:10000},include:{type:'array',items:{type:'string'}},exclude:{type:'array',items:{type:'string'}},examples:{type:'array',items:{type:'string'}}}},
  EvaluationExpected:{type:'object',required:['typeId','tags','riskRuleIds','highRiskRuleIds','background'],properties:{typeId:{type:'string'},tags:{type:'array',items:{type:'string'}},riskRuleIds:{type:'array',items:{type:'string'}},highRiskRuleIds:{type:'array',items:{type:'string'},description:'必须为riskRuleIds的子集'},background:{$ref:'#/components/schemas/Background'}}},
  Error:{type:'object',properties:{code:{type:'string'},message:{type:'string'}}},
};
const str={type:'string'},uuid={type:'string',format:'uuid'},revision={$ref:'#/components/schemas/Revision'},background={$ref:'#/components/schemas/Background'};
const object=(properties,required=Object.keys(properties))=>({type:'object',properties,required});
const entries=[
 ['get','/health','数据库连通性',null,'public'],['get','/auth/session','获取当前用户及CSRF令牌',null,'public'],['post','/auth/login','账号登录，轮换会话',object({username:str,password:{type:'string',format:'password'}}),'public'],['post','/auth/logout','退出会话'],
 ['get','/catalog','分类目录、标签、目录版本；每个类型的reviewEnabled取决于已发布专项规则，trialAvailable表示可内置示例试审'],['get','/contracts','查询授权合同；page启用每页50条分页，支持q/status/source/type/reviewer筛选，未分页兼容最近200条'],
 ['post','/contracts/upload','上传PDF/DOCX并创建初始版本',object({file:{type:'string',format:'binary'},title:str,background:{type:'string',description:'序列化Background JSON'}},['file','background']),'session','multipart/form-data'],
 ['get','/contracts/{id}','读取合同、版本、预审、结论、退回和归档'],
 ['patch','/contracts/{id}/background','更新背景并重新预审',object({revision,background})],
 ['post','/contracts/{id}/versions','上传修改稿、补充材料或签署件',object({revision,file:{type:'string',format:'binary'},kind:{enum:['contract','supplement','signed']}},['revision','file']),'session','multipart/form-data'],
 ['put','/contracts/{id}/classification','法务确认或纠正分类及立场',object({revision,typeId:str,tags:{type:'array',items:str},perspectiveConfirmed:{const:true}})],
 ['put','/contracts/{id}/assignment','法务分配负责人',object({revision,reviewerId:{oneOf:[uuid,{type:'null'}]}})],['get','/reviewers','可分配法务账号目录'],
 ['post','/reviews','创建当前文件的异步预审；trial固定内置示例快照，不能确认最终结论',object({contractId:uuid,revision,mode:{enum:['formal','trial'],default:'formal',description:'formal只使用已发布规则；trial使用版本固定的内置示例规则'}},['contractId','revision'])],['get','/reviews/{id}','任务进度、检查项、快照和步骤；snapshot.reviewMode区分formal/trial，旧记录默认为formal'],
 ['post','/reviews/{id}/cancel','取消尚未完成的任务',object({revision})],
 ['put','/reviews/{id}/findings/{findingId}/disposition','法务复核检查项',object({revision,action:{enum:['accept','reject','correct','needs_information','acknowledge']},reason:str,suggestion:str,severity:{enum:['high','medium','low']}},['revision','action'])],
 ['post','/reviews/{id}/findings','添加人工风险',object({title:str,reason:str,suggestion:str,severity:{enum:['high','medium','low']},evidence:{type:'array',items:{$ref:'#/components/schemas/Evidence'}}},['title','reason','severity'])],
 ['post','/reviews/{id}/return','退回业务修改或补件',object({revision,reason:{type:'string',minLength:1}})],
 ['post','/reviews/{id}/decision','法务最终结论，不能覆盖已有结论',object({revision,outcome:{enum:['agree','conditional','disagree']},reason:str,conditions:str},['revision','outcome'])],
 ['get','/reviews/{id}/report','导出报告（format=html/docx/pdf）'],
 ['post','/contracts/{id}/archive','记录人工回传并关联归档件',object({revision,manuallyReturned:{const:true},note:str,signedVersionId:uuid},['revision','manuallyReturned'])],
 ['get','/files/{versionId}','按会话或限时版本凭证读取文件'],['get','/contracts/{id}/editor','创建受控OnlyOffice编辑会话'],
 ['post','/onlyoffice/callback','OnlyOffice保存回调，需有效HS256签名',object({key:str,status:{type:'integer'},url:str,token:str},['key','status','token']),'office'],
 ['get','/rule-packs','全部规则版本'],['post','/rule-packs/{id}/versions','创建新规则草稿',{$ref:'#/components/schemas/RulePack'}],
 ['put','/rule-pack-versions/{id}','原地保存草稿；revision防止覆盖并发修改',{allOf:[{$ref:'#/components/schemas/RulePack'},object({revision})]}],
 ...['submit','publish','retire'].map(action=>['post',`/rule-pack-versions/{id}/${action}`,'规则版本状态变更：'+action,object({revision})]),
 ['get','/feedback-cases','候选反馈列表'],['post','/feedback-cases','提交候选反馈',object({reviewId:uuid,findingId:uuid,kind:{enum:['rule','false_positive','false_negative','classification','normal_expression']},content:str},['kind','content'])],
 ['patch','/feedback-cases/{id}','更新反馈状态；需携带revision，正式规则发布时自动关联反馈',object({revision,state:{enum:['pending','published','retired']},ruleVersionId:uuid},['revision','state'])],
 ['post','/feedback-cases/{id}/rule-draft','按反馈复制当前正式规则为草稿；重复请求复用；无法定位返回RULE_SELECTION_REQUIRED，需显式选择packId',object({packId:str},[])],
 ['post','/feedback-cases/{id}/knowledge-draft','将正常表达加入规则参考资料草稿，确认发布后生效',object({packId:str},[])],
 ['get','/feedback-cases/{id}/context','反馈原文、提交人、不可变合同版本、检查项和法务处理记录'],
 ['get','/feedback-cases/{id}/evaluation-preview','自动带入合同正文、人工确认分类、风险和高风险项，供法务核实'],
 ['post','/feedback-cases/{id}/evaluation-case','确认反馈标注后保存样本；按反馈去重',object({name:str,split:{enum:['development','holdout']},expected:{$ref:'#/components/schemas/EvaluationExpected'},confirmed:{const:true}})],
 ['get','/classification-guidance','分类指导全部版本'],
 ['post','/classification-guidance/{typeId}/versions','创建分类指导草稿',{$ref:'#/components/schemas/ClassificationGuidance'}],
 ['put','/classification-guidance-versions/{id}','保存分类指导草稿；需revision',{allOf:[{$ref:'#/components/schemas/ClassificationGuidance'},object({revision})]}],
 ['post','/classification-guidance-versions/{id}/publish','确认发布分类指导，只影响后续创建的预审',object({revision})],
 ['post','/feedback-cases/{id}/classification-draft','为人工纠正类型创建分类指导草稿；未确认类型需显式选择typeId',object({typeId:str},[])],
 ['get','/evaluation-cases','标注样本列表'],['post','/evaluation-cases','保存法务标注样本',object({name:str,split:{enum:['development','holdout']},document:object({blocks:{type:'array',items:object({id:str,text:str})}}),expected:object({typeId:str,tags:{type:'array',items:str},highRiskRuleIds:{type:'array',items:str},riskRuleIds:{type:'array',items:str},background},['typeId'])})],
 ['post','/evaluations','异步运行模型/规则评测；草稿仅用于development并固定其内容和revision',object({adapters:{type:'array',minItems:1,items:{enum:['llm','jev']}},split:{enum:['development','holdout']},includeReview:{type:'boolean',default:true},draftRuleVersionId:uuid},['adapters','split'])],['get','/evaluations','评测记录及结果'],
 ['get','/settings','管理员读取脱敏配置'],['put','/settings/model','保存指定模型服务，密钥加密',object({baseUrl:{type:'string',format:'uri'},name:str,apiKey:{type:'string',format:'password'}},['baseUrl','name'])],
 ['post','/settings/model/test','验证当前表单的模型连接与JSON输出；仅发送固定测试文本',object({baseUrl:str,name:str,apiKey:{type:'string',format:'password'}},['baseUrl','name'])],
 ['post','/settings/model/models','从当前指定服务读取可选模型列表',object({baseUrl:str,name:str,apiKey:{type:'string',format:'password'}},['baseUrl','name'])],
 ['post','/settings/diagnostics','检查数据库、Worker、存储和已配置内部服务'],
 ['put','/settings/dingtalk-connection','保存钉钉启停、应用标识及加密密钥；Worker自动应用',object({enabled:{type:'boolean'},clientId:str,clientSecret:{type:'string',format:'password'},expectedUpdatedAt:{type:['string','null']}},['enabled','clientId'])],
 ['post','/settings/dingtalk/test','仅验证应用鉴权，不读取审批，不返回accessToken',object({enabled:{type:'boolean'},clientId:str,clientSecret:{type:'string',format:'password'}},['enabled','clientId'])],
 ['get','/dingtalk/account','管理员读取本人绑定状态，不返回企业UserID'],
 ['post','/dingtalk/account/start','创建10分钟有效的一次性网页登录授权请求，返回授权URL'],
 ['post','/dingtalk/account/complete','验证授权码、state与企业身份并绑定本人账号',object({code:str,state:{type:'string',minLength:64,maxLength:64}})],
 ['delete','/dingtalk/account','解除本人钉钉绑定，撤销未完成请求'],
 ['get','/users','管理员查询账号；所有账号统一roles=[admin]'],['post','/users','创建管理员账号，department仅作备注，无需指定角色',object({username:str,password:{type:'string',minLength:12},displayName:str,department:str,active:{type:'boolean',default:true}},['username','password','displayName'])],
 ['patch','/users/{id}','更新管理员信息及启停，不能停用最后一个管理员',object({revision,displayName:str,department:str,active:{type:'boolean'},password:{type:'string',minLength:12}},['revision','displayName','department','active'])],
 ['get','/operations','管理员查询任务、接入和备份状态；接入summary包含collected/duplicate/skipped/failed及原因'],['post','/operations/{kind}/{id}/retry','重试reviews或events任务'],['get','/audit-events','管理员查询最近200条审计'],
];
const paths={};
for(const[method,url,summary,body,security='session',mime='application/json']of entries){
  const parameters=[...url.matchAll(/\{([^}]+)\}/g)].map(m=>({name:m[1],in:'path',required:true,schema:{type:'string'}}));
  if(method!=='get'&&security!=='office')parameters.push({name:'X-CSRF-Token',in:'header',required:true,schema:str,description:'来自GET /auth/session；登录后使用新令牌'});
  if(url==='/reviews/{id}/report')parameters.push({name:'format',in:'query',schema:{enum:['html','docx','pdf'],default:'html'}});
  if(url==='/contracts')parameters.push(...Object.entries({page:{type:'integer',minimum:1,description:'启用50条/页响应：items,total,page,pageSize'},q:str,status:{enum:['pending_review','in_review','returned','finalized','archived']},source:{enum:['manual','dingtalk']},type:str,reviewer:{type:'string',description:'法务UUID或unassigned'}}).map(([name,schema])=>({name,in:'query',schema})));
  if(url==='/files/{versionId}')parameters.push({name:'token',in:'query',schema:str,description:'仅编辑器使用，包含versionId/userId/aud和15分钟有效期'},{name:'download',in:'query',schema:{type:'string',enum:['1']}});
  const responses={200:{description:'成功；异步任务查询数据库状态'},400:{description:'输入无效'},401:{description:'需要登录或签名无效'},403:{description:'无角色权限、CSRF或Origin校验失败'},404:{description:'不存在或没有合同访问权限'},409:{description:'记录revision冲突、历史版本或业务前置条件未满足'},422:{description:'缺少业务配置或需人工处理'},500:{description:'内部错误，不回显正文或密钥'}};
  if(method==='post')responses[201]={description:'新资源创建成功'};if(url==='/reviews'||url==='/evaluations'||url.includes('/retry'))responses[202]={description:'异步任务已持久化，返回任务ID'};
  const op={summary,operationId:method+'_'+url.replace(/[^a-zA-Z0-9]+/g,'_'),security:security==='public'?[]:security==='office'?[{officeJwt:[]}]:[{sessionCookie:[]}],parameters,responses};
  if(body)op.requestBody={required:true,content:{[mime]:{schema:body}}};
  paths[url]||={};paths[url][method]=op;
}
const spec={openapi:'3.1.0',info:{title:'法律 Agent 合同预审工作台 API',version:'1.1.0',description:'统一系统管理员可操作全部合同与功能；每次操作保留实际账号审计。反馈需经草稿和确认发布后生效，不训练模型。技术完成不等于法务批准；最终结论绑定当前文件和任务。状态与数据结构见开发说明，业务事实以数据库为准。'},servers:[{url:'/api'}],paths,components:{securitySchemes:{sessionCookie:{type:'apiKey',in:'cookie',name:'legal.sid'},officeJwt:{type:'http',scheme:'bearer',bearerFormat:'JWT',description:'HS256签名；也可放在回调body.token'}},schemas}};
fs.mkdirSync(path.resolve(__dirname,'../docs'),{recursive:true});fs.writeFileSync(path.resolve(__dirname,'../docs/openapi.json'),JSON.stringify(spec,null,2)+'\n');console.log(`OpenAPI written: ${entries.length} operations`);
