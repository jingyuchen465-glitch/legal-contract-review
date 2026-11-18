const fs=require('node:fs');
const path=require('node:path');
const schemas={
  SkillPack:{type:'object',required:['name','scope','skills'],properties:{name:{type:'string',maxLength:200},scope:{type:'object',required:['level'],properties:{level:{enum:['common','type']},typeIds:{type:'array',maxItems:1,items:{type:'string'}}}},skills:{type:'array',minItems:1,description:'分类累积模式解除20条限制，运行时完整分批装载',items:{type:'object',required:['id','title','method'],properties:{id:{type:'string'},title:{type:'string'},method:{type:'string',maxLength:6000},conditions:{type:'array',items:{type:'string'}},exclusions:{type:'array',items:{type:'string'}},examples:{type:'array',items:{type:'string'}}}}}}},
  Background:{type:'object',required:[],properties:{ourEntity:{type:'string',maxLength:200,description:'选择甲方/乙方时可留空，按合同所列主体审查，不代表完成工商核验'},ourSide:{enum:['','party_a','party_b','other']},supplementIds:{type:'array',maxItems:100,items:{type:'string',format:'uuid'},description:'本合同关联材料ID，省略时全部关联，空数组不关联'},perspective:{type:'string',maxLength:200},purpose:{type:'string',maxLength:3000,description:'交易目的及本次重点检查项'}}},
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
const setup={type:'object',required:['partyId','typeId','templateId','pointIds','corePurposes'],properties:{partyId:str,customParty:object({name:str,role:str}),typeId:str,templateId:str,pointIds:{type:'array',minItems:1,maxItems:150,items:str},corePurposes:{type:'array',minItems:1,maxItems:20,items:{type:'string',minLength:1,maxLength:500}}}};
const entries=[
 ['get','/auto-review-limits','查询自动评审批次文件数量、单文件和总大小限制'],
 ['get','/auto-review-batches','列出有权限的自动评审批次、材料、阶段、风险与改稿状态'],
 ['post','/auto-review-batches','多文件上传建立自动评审批次；支持files或files[]，clientKey或Idempotency-Key幂等，20份/50MB/200MB默认限制',object({'files[]':{type:'array',items:{type:'string',format:'binary'},maxItems:20},background:{type:'string',description:'序列化Background JSON'},clientKey:str,title:str},['files[]']),'session','multipart/form-data'],
 ['get','/auto-review-batches/{id}','批次详情：材料、计划、方法、暂停原因、报告和改稿；法务另获同部门learningSources，含人工审阅整理进度、生成数量和待审核数'],
 ['get','/contracts/{id}/review-document','读取有权限的固定DOCX版本用于审阅；versionId可选，reviewId可选且必须属于所选文件；只读获取不会触发经验整理'],
 ['post','/contracts/{id}/review-document','法务保存DOCX审阅；以实际打开的baseVersionId核验人工正文、原生修订及批注变化；来源与文件原子保存，返回learning.sourceId/status/message；状态变化不调用提炼模型，实质处理仅生成待审核草稿',object({file:{type:'string',format:'binary'},baseVersionId:uuid,reviewId:uuid,reviewReason:{type:'string',maxLength:3000,description:'本次修改理由和适用条件，可选'},reviewActions:{type:'string',description:'可选JSON数组，最多300条{action:accept|reject,insertedText,deletedText}，每项文字最多20000字；须由保存前后原生修订核验，撤销操作不计入有效决策'}},['file','baseVersionId']),'session','multipart/form-data'],
 ...['cancel','resume','retry'].map(action=>['post',`/auto-review-batches/{id}/${action}`,'停止实际任务或恢复、重试；保留原件和历史产物',object({background},[])]),
 ['get','/auto-review-batches/{id}/artifacts/{artifactId}/download','按批次所有材料权限下载审查报告或 Word 批注建议稿（历史修订稿仍可下载）；新批注产物 kind=annotated_comments，details.outputMode=comments_only、editCount=0'],
 ['post','/contracts/{id}/skill-draft','将同一合同的审查点统一采纳为一个综合技能草稿；重试幂等；更新固定技能身份并核对来源修订号；关联规则须先发布',object({tasks:{type:'array',minItems:1,items:object({id:uuid,revision})},name:{type:'string',maxLength:200},excluded:{type:'array',items:object({taskId:uuid,proposalId:uuid,reason:{type:'string',minLength:1,maxLength:2000}})}},['tasks'])],
 ['get','/skill-entries','按合同大类列出标准SKILL.md入口初稿及全部入口版本'],
 ['post','/skill-entries/{key}/versions','创建大类入口草稿，key为common或目录categoryId；baseVersionId固定正式父版',object({name:str,description:str,body:str,baseVersionId:{type:['string','null'],format:'uuid'}},['name','description','body'])],
 ['put','/skill-entry-versions/{id}','保存入口草稿，Markdown正文与描述均经过人工审核后发布',object({name:str,description:str,body:str,revision})],
 ...['submit','publish'].map(action=>['post',`/skill-entry-versions/{id}/${action}`,'入口版本状态变更：'+action+'；通用入口发布需commonConfirmed:true',object({revision,commonConfirmed:{type:'boolean'}},['revision'])]),
 ['get','/skill-pack-versions/{id}/files','读取技能版本的SKILL.md及引用正文，返回bundle哈希、逐文件哈希与contents；草稿仅作预览'],
 ['get','/skill-pack-versions/{id}/bundle','下载包含SKILL.md与references的标准技能ZIP；不含原始证据及联系方式'],
 ['get','/word-conversion-capabilities','查询PDF转换开关、50MB与100页限制'],
 ['get','/versions/{id}/word-conversions','列出当前合同权限内的Word转换记录'],
 ['post','/versions/{id}/word-conversions','异步创建或复用PDF到Word转换任务；202返回任务与状态',object({})],
 ['get','/word-conversions/{id}','查询逐页识别进度、错误及脱敏产物链接'],
 ['post','/word-conversions/{id}/retry','复用成功页面，仅重试失败任务',object({})],
 ['get','/word-conversions/{id}/files/{kind}','同源合同权限下载docx、pdf预览或report；不修改原版本'],
 ['post','/contracts/{id}/versions/from-conversion','核对确认后创建Word新版本；并发检查且重复提交幂等',object({conversionId:uuid,revision,acknowledged:{const:true}})],
 ['get','/dingtalk/intake-settings','查询新审批联合审查开关及首次启用时间；历史收件模式固定'],
 ['put','/dingtalk/intake-settings','管理员启停新收件流程，不改变已有审批模式',object({enabled:{type:'boolean'},updatedAt:{type:['string','null']}})],
 ['get','/dingtalk/intakes','按当前合同权限列出审批收件包'],
 ['get','/dingtalk/intakes/{id}','全部附件收取/解析状态、AI建议、人工草稿及已确认合同组'],
 ['put','/dingtalk/intakes/{id}/groups','保存人工分组草稿；每组一份主合同，其他材料角色supplement/schedule/reference，excluded须说明原因',object({revision,selection:{type:'object',required:['groups'],properties:{groups:{type:'array',items:object({name:str,mainDocumentId:uuid,materials:{type:'array',items:object({documentId:uuid,role:{enum:['supplement','schedule','reference']}})}})},excluded:{type:'array',items:object({documentId:uuid,reason:str})}}}})],
 ['post','/dingtalk/intakes/{id}/confirm','事务确认分组和排除记录，返回各组contractId及异步preanalysisId；所有附件必须明确处理',object({revision,selection:{type:'object'}})],
 ['post','/dingtalk/intakes/{id}/analyze','后台转换解析全部附件并建议分组，人工草稿保留',object({revision})],
 ['post','/dingtalk/intakes/{id}/retry','重新收取该审批全部附件；不发送消息或回传附件',object({revision})],
 ['post','/dingtalk/intakes/{id}/documents','人工添加关联材料；先确认归属后参与联审',object({revision,file:{type:'string',format:'binary'}}),'session','multipart/form-data'],
 ['post','/dingtalk/intakes/{id}/documents/{documentId}/file','补传失败材料或上传同一文件的修改版本；使引用组失效',object({revision,file:{type:'string',format:'binary'}}),'session','multipart/form-data'],
 ['post','/contracts/{id}/preanalysis','持久异步预分析，202返回；活动任务幂等，读取合同详情恢复进度与结果',object({revision,restart:{type:'boolean'}},['revision'])],
 ['patch','/preanalyses/{id}/selection','保存待确认审查选择，校验主体、模板、检查项与预分析版本',object({revision,selection:setup})],
 ['post','/preanalyses/{id}/start','法务确认后创建正式审查；合同版本校验、固定选择、重复提交幂等',object({revision,contractRevision:revision,selection:setup})],
 ['get','/skill-packs','技能包全部版本；草稿及历史版本不参与新预审'],
 ['post','/skill-packs/{id}/versions','创建技能草稿；id为review-skill-common或review-skill-{typeId}，baseVersionId防止覆盖新版',{allOf:[{$ref:'#/components/schemas/SkillPack'},object({baseVersionId:{type:['string','null'],format:'uuid'}},[])]}],
 ['put','/skill-pack-versions/{id}','保存技能草稿，来源及规则依赖不可由客户端改写',{allOf:[{$ref:'#/components/schemas/SkillPack'},object({revision})]}],
 ...['submit','publish','retire'].map(action=>['post',`/skill-pack-versions/{id}/${action}`,'技能版本状态变更：'+action+'；发布要求依赖规则已发布，通用技能须明确确认',object({revision,commonConfirmed:{type:'boolean'}},['revision'])]),
 ['get','/skill-pack-versions/{id}/export','下载Markdown技能包，正文不包含来源合同原文'],
 ['get','/skill-pack-versions/{id}/sources','按合同权限返回来源合同及确认版本关联'],
 ['get','/learning-settings','自动经验整理开关；缺省关闭'],['put','/learning-settings','管理员切换自动整理；不补录历史合同',object({enabled:{type:'boolean'},updatedAt:{type:['string','null']}})],
 ['get','/learning-proposals','分类建议分页列表；kind=skill/rule，支持categoryId/typeId/tag/state/contractId/taskId/page/limit；groupBy=contract时按合同分页，items[].tasks保留完整审查点及关联规则；统计遵循来源合同权限'],
 ['get','/learning-reorganizations','历史分类纠正、归并与迁移候选；不修改原记录'],
 ['post','/learning-reorganizations','扫描授权合同生成候选，202返回；不发布标准',object({contractId:uuid},[])],
 ['post','/learning-reorganizations/{id}/retry','重新生成已失败或待审核候选',object({})],
 ['post','/learning-reorganizations/{id}/apply','人工确认后事务应用分类、归并及已有方法迁移；保留历史预审与原始提案',object({revision,confirmed:{const:true}})],
 ['post','/learning-tasks/{id}/proposals/{proposalId}/reopen','恢复已覆盖建议为待确认，不发布法律标准',object({revision})],
 ['get','/learning-tasks','查询最近100条有权限的经验任务，支持contractId筛选；含结论语境、提案及原内容快照'],
 ['get','/learning-tasks/{id}/changes','按合同权限分页查询前后正文差异，返回新增、删除、修改及双方版本原文锚点'],
 ['post','/learning-tasks/{id}/retry','重新整理非运行状态的任务，保留已采纳或忽略的提案',object({revision})],
 ['put','/learning-tasks/{id}/proposals/{proposalId}','编辑待确认提案；证据、范围、目标及依赖由服务端保留',object({revision,title:str,reason:str,method:str,instruction:str,conditions:{type:'array',items:str},exclusions:{type:'array',items:str},examples:{type:'array',items:str},severity:{enum:['high','medium','low']}},['revision'])],
 ['post','/learning-tasks/{id}/proposals/{proposalId}/adopt','采纳为规则或技能草稿；依赖规则先采纳，通用推广须明确确认',object({revision,rulePackId:str,commonConfirmed:{type:'boolean'}},['revision'])],
 ['post','/learning-tasks/{id}/proposals/{proposalId}/ignore','忽略经验提案；不会影响已确认结论',object({revision})],
 ['get','/health','数据库连通性',null,'public'],['get','/auth/session','获取当前用户及CSRF令牌',null,'public'],['post','/auth/login','账号登录，轮换会话',object({username:str,password:{type:'string',format:'password'}}),'public'],['post','/auth/logout','退出会话'],
 ['get','/catalog','分类目录、标签、目录版本；全部类型提供内置审查要点，已有公司专项标准优先'],['get','/contracts','查询授权合同；page启用每页50条分页，支持q/status/source/type/reviewer筛选，未分页兼容最近200条'],
 ['post','/contracts/upload','上传合同并填写类型与背景；原件不变，Office 格式由后台转换',object({file:{type:'string',format:'binary'},title:str,reviewFlow:{enum:['guided','automatic'],default:'automatic',description:'当前工作台提交guided：后台预分析，确认后才正式审查；省略兼容旧API自动审查协议'},background:{type:'string',description:'序列化Background JSON；guided模式可省略'},classification:{type:'string',description:'可选JSON：typeId、tags、perspectiveConfirmed。所选类型用于首次预审；仅法务或管理员可将perspectiveConfirmed设为true并同时确认分类及立场；省略则由AI识别。'}},['file']),'session','multipart/form-data'],
 ['get','/contracts/{id}','读取合同、版本、预审、结论、退回和归档'],
 ['get','/review-plan','按合同类型、专项标签预览适用内置或公司审查要点，不创建任务'],
 ['get','/versions/{id}/editable-word','将已完成识别的PDF文字重建为可编辑DOCX；不保留精确版式，不替换原件'],
 ['get','/reviews/{id}/final-contract','下载法务确认同意的文件原件，绑定结论版本并校验SHA-256；历史确认稿不跟随后续上传改变'],
 ['patch','/contracts/{id}/background','更新背景并重新预审',object({revision,background})],
 ['post','/contracts/{id}/versions','上传修改稿、补充材料或签署件',object({revision,file:{type:'string',format:'binary'},kind:{enum:['contract','supplement','signed']}},['revision','file']),'session','multipart/form-data'],
 ['put','/contracts/{id}/classification','法务确认或纠正分类及立场',object({revision,typeId:str,tags:{type:'array',items:str},perspectiveConfirmed:{const:true}})],
 ['put','/contracts/{id}/assignment','法务分配负责人',object({revision,reviewerId:{oneOf:[uuid,{type:'null'}]}})],['get','/reviewers','可分配法务账号目录'],
 ['post','/reviews','创建当前文件的异步预审；trial固定内置示例快照，不能确认最终结论',object({contractId:uuid,revision,mode:{enum:['formal','trial'],default:'formal',description:'formal只使用已发布规则；trial使用版本固定的内置示例规则'}},['contractId','revision'])],['get','/reviews/{id}','任务进度、检查项、快照和步骤；snapshot.reviewMode区分formal/trial，旧记录默认为formal'],
 ['post','/reviews/{id}/cancel','取消尚未完成的任务',object({revision})],
 ['put','/reviews/{id}/findings/{findingId}/disposition','法务复核检查项；applyToDuplicates只同时处理内容、证据及现有处理状态一致的意见',object({revision,action:{enum:['accept','reject','correct','needs_information','acknowledge']},reason:str,suggestion:str,severity:{enum:['high','medium','low']},applyToDuplicates:{type:'boolean',default:false}},['revision','action'])],
 ['post','/reviews/{id}/findings','添加人工风险',object({title:str,reason:str,suggestion:str,severity:{enum:['high','medium','low']},evidence:{type:'array',items:{$ref:'#/components/schemas/Evidence'}}},['title','reason','severity'])],
 ['post','/reviews/{id}/return','退回业务修改或补件',object({revision,reason:{type:'string',minLength:1}})],
 ['post','/reviews/{id}/decision','法务最终结论，不能覆盖已有结论',object({revision,outcome:{enum:['agree','conditional','disagree']},reason:str,conditions:str},['revision','outcome'])],
 ['get','/reviews/{id}/report','导出报告（format=html/docx/pdf）'],
 ['get','/reviews/{id}/annotated-contract','导出本次预审对应的原合同副本；mode=comments（原生Word批注，默认）或color（批注及彩色建议段落），仅支持已完成预审的DOCX。缺失或无法定位的意见作为首段全文批注；驳回和通过项不导出'],
 ['post','/contracts/{id}/archive','记录人工回传并关联归档件',object({revision,manuallyReturned:{const:true},note:str,signedVersionId:uuid},['revision','manuallyReturned'])],
 ['post','/versions/{id}/conversion','重试补充材料或签署件的失败转换；主合同通过重新预审重试',object({},[])],
 ['get','/files/{versionId}','按会话或限时版本凭证读取原件；variant=pdf/docx/text 读取转换副本，使用同一合同权限'],['get','/contracts/{id}/editor','创建受控OnlyOffice编辑会话'],
 ['post','/contracts/{id}/editor/{key}/draft','法务生成完整条款改稿预览；绑定当前版本、意见及编辑会话，30分钟有效；返回explanation、edits与签名token，不修改正文',object({reviewId:uuid,findingId:uuid})],
 ['post','/contracts/{id}/editor/{key}/apply-draft','核对签名、当前版本及意见后应用改稿，生成含Word增删修订的新版本并关闭旧会话；不自动采纳意见，返回versionId、versionNo、saved',object({token:str})],
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
schemas.SkillPack.properties.originContractId={type:'string',format:'uuid',description:'创建已有综合技能的新版本时携带来源合同ID；固定packId为review-contract-{contractId}'};
schemas.SkillPack.properties.removedItemIds={type:'array',items:{type:'string'}};
schemas.SkillPack.properties.removalReason={type:'string',description:'综合技能排除审查点时必填；记录审计'};
schemas.SkillFileBundle={type:'object',required:['hash','compilerVersion','entryKey','entryVersionId','sections','files'],properties:{hash:{type:'string',pattern:'^[a-f0-9]{64}$'},compilerVersion:{enum:['contract-skill-files-1','contract-skill-files-2']},entryKey:str,entryVersionId:{type:['string','null'],format:'uuid'},commonEntryVersionId:{type:['string','null'],format:'uuid',description:'生成器v2固定通用入口版本；未自定义时为null'},sections:{type:'array',items:object({id:str,start:{type:'integer',minimum:0},end:{type:'integer',minimum:0}})},files:{type:'array',minItems:2,maxItems:2,items:object({path:str,sha256:{type:'string',pattern:'^[a-f0-9]{64}$'}})}}};
schemas.ContractSkillVersion={allOf:[{$ref:'#/components/schemas/SkillPack'},{type:'object',properties:{id:uuid,pack_id:str,origin_contract_id:uuid,version_no:{type:'integer'},base_version_id:{type:['string','null'],format:'uuid'},revision,state:{enum:['draft','pending','published','retired']},sources:{type:'array',items:object({id:uuid,contractId:uuid,decisionId:uuid,versionId:uuid},['id','contractId'])},file_bundle:{anyOf:[{$ref:'#/components/schemas/SkillFileBundle'},{type:'null'}]},legacy_replacements:{type:'array',description:'仅在后续新任务中替代来源完全属于本合同的旧方法；共享方法保留',items:{type:'object'}}}}]};
schemas.SkillEntryVersion=object({id:uuid,entry_key:str,name:str,description:str,body:str,version_no:{type:'integer',minimum:1},base_version_id:{type:['string','null'],format:'uuid'},revision,state:{enum:['draft','pending','published','retired']}},['id','entry_key','name','description','body','version_no','revision','state']);
const paths={};
for(const[method,url,summary,body,security='session',mime='application/json']of entries){
  const parameters=[...url.matchAll(/\{([^}]+)\}/g)].map(m=>({name:m[1],in:'path',required:true,schema:{type:'string'}}));
  if(method!=='get'&&security!=='office')parameters.push({name:'X-CSRF-Token',in:'header',required:true,schema:str,description:'来自GET /auth/session；登录后使用新令牌'});
  if(url==='/auto-review-batches'&&method==='post')parameters.push({name:'Idempotency-Key',in:'header',schema:str,description:'可用表单clientKey替代'});
  if(url==='/reviews/{id}/report')parameters.push({name:'format',in:'query',schema:{enum:['html','docx','pdf'],default:'html'}});
  if(['/reviews/{id}/annotated-contract','/reviews/{id}/final-contract'].includes(url))parameters.push({name:'versionId',in:'query',schema:uuid,description:'省略为主合同；联审中仅可选择本次冻结快照内的文件版本'});
  if(url==='/learning-tasks/{id}/changes')parameters.push({name:'documentId',in:'query',schema:uuid,description:'联合审查按同一文件的前后版本对比；省略为第一份文件'});
  if(url==='/learning-proposals')parameters.push({name:'groupBy',in:'query',schema:{enum:['contract']},description:'按合同聚合分页；total为合同数、checkTotal为匹配审查点数，items[].tasks含完整任务'});
  if(url==='/review-plan')parameters.push({name:'typeId',in:'query',required:true,schema:str},{name:'tags',in:'query',schema:str,description:'JSON字符串数组；默认[]'},{name:'mode',in:'query',schema:{enum:['formal','trial'],default:'formal'}});
  if(url==='/learning-tasks/{id}/changes')parameters.push({name:'offset',in:'query',schema:{type:'integer',minimum:0,default:0}},{name:'limit',in:'query',schema:{type:'integer',minimum:1,maximum:50,default:20}});
  if(url==='/contracts')parameters.push(...Object.entries({page:{type:'integer',minimum:1,description:'启用50条/页响应：items,total,page,pageSize'},q:str,status:{enum:['pending_review','in_review','returned','finalized','archived']},source:{enum:['manual','dingtalk']},type:str,reviewer:{type:'string',description:'法务UUID或unassigned'}}).map(([name,schema])=>({name,in:'query',schema})));
  if(url==='/files/{versionId}')parameters.push({name:'token',in:'query',schema:str,description:'仅编辑器使用，包含versionId/userId/aud和15分钟有效期'},{name:'download',in:'query',schema:{type:'string',enum:['1']}});
  const responses={200:{description:'成功；异步任务查询数据库状态'},400:{description:'输入无效'},401:{description:'需要登录或签名无效'},403:{description:'无角色权限、CSRF或Origin校验失败'},404:{description:'不存在或没有合同访问权限'},409:{description:'记录revision冲突、历史版本或业务前置条件未满足'},422:{description:'缺少业务配置或需人工处理'},500:{description:'内部错误，不回显正文或密钥'}};
  if(method==='post')responses[201]={description:'新资源创建成功'};if(url==='/reviews'||url==='/evaluations'||url.includes('/retry'))responses[202]={description:'异步任务已持久化，返回任务ID'};
  if(method==='post'&&url.startsWith('/auto-review-batches'))responses[202]={description:'批次或控制命令已持久化，返回批次状态'};
  if(url.startsWith('/auto-review'))responses[413]={description:'文件数量、单文件或批次总大小超过配置限制'};
  const op={summary,operationId:method+'_'+url.replace(/[^a-zA-Z0-9]+/g,'_'),security:security==='public'?[]:security==='office'?[{officeJwt:[]}]:[{sessionCookie:[]}],parameters,responses};
  if(body)op.requestBody={required:true,content:{[mime]:{schema:body}}};
  paths[url]||={};paths[url][method]=op;
}
const jsonResponse=(description,schema)=>({description,content:{'application/json':{schema}}});
paths['/contracts/{id}/skill-draft'].post.responses[201]=jsonResponse('综合技能草稿；重复采纳相同来源返回同一id，不增加版本',{$ref:'#/components/schemas/ContractSkillVersion'});
paths['/contracts/{id}/skill-draft'].post.responses[409].description='CONTRACT_SKILL_DRAFT_EXISTS：先处理已有草稿；SKILL_BASE_CHANGED：重新整理核对；SKILL_RULE_REQUIRED：先发布关联规则；SKILL_NO_CHANGE：无新增经验；REVISION_CONFLICT：来源已更新';
paths['/skill-entries/{key}/versions'].post.responses[201]=jsonResponse('大类或通用入口草稿',{$ref:'#/components/schemas/SkillEntryVersion'});
paths['/skill-entry-versions/{id}'].put.responses[200]=jsonResponse('保存后的入口草稿及新revision',{$ref:'#/components/schemas/SkillEntryVersion'});
paths['/skill-pack-versions/{id}/files'].get.responses[200]=jsonResponse('草稿预览或该已发布版本的不可变文件；不包含原始证据',object({bundle:{$ref:'#/components/schemas/SkillFileBundle'},contents:{type:'object',additionalProperties:{type:'string'}}}));
paths['/skill-pack-versions/{id}/bundle'].get.responses[200]={description:'标准技能目录ZIP',content:{'application/zip':{schema:{type:'string',format:'binary'}}}};
// Preserve historical reads and explicitly describe retired writes as 410.
for(const [url,operations]of Object.entries(paths))for(const [method,operation]of Object.entries(operations)){
 const retired=url==='/reviews'||url==='/review-plan'||/^\/(?:rule-packs|rule-pack-versions|skill-packs|skill-pack-versions|skill-entries|skill-entry-versions|learning-tasks|learning-proposals|learning-settings|learning-reorganizations|classification-guidance|classification-guidance-versions|preanalyses|feedback-cases|evaluation-cases|evaluations)(?:\/|$)/.test(url)||/^\/contracts\/\{id\}\/(?:classification|preanalysis|skill|skills|learning|review-plan|review-setup)/.test(url)||/^\/reviews\/\{id\}\/cancel$/.test(url);
 if(retired&&(method!=='get'||url==='/review-plan')){operation.deprecated=true;operation.summary='已退役：请使用 Agent 会话或风险证据评测';operation.responses={401:operation.responses[401],403:operation.responses[403],410:{description:'REVIEW_ENGINE_RETIRED；历史读取与导出继续保留'}};}
}
const message=object({content:{type:'string',minLength:1,maxLength:20000},clientKey:{type:'string',minLength:1,maxLength:100},learn:{type:'boolean',description:'仅明确法务反馈可提炼长期经验；普通追问不学习'}},['content','clientKey']);
const questionAnswer=object({id:{type:'string',minLength:1,maxLength:80},selected:{type:'array',maxItems:8,items:{type:'string',minLength:1,maxLength:200}},custom:{type:'string',maxLength:3000}},['id','selected']);
const structuredAnswer={...message,properties:{...message.properties,content:{type:'string',maxLength:20000,description:'文字回答；提供answers时作为额外补充说明'},questionId:uuid,answers:{type:'array',minItems:1,maxItems:6,items:questionAnswer,description:'按待答消息data.questions的id及选项label逐题回答，selected=[]时可填写custom'}},required:['clientKey','questionId'],anyOf:[{required:['content'],properties:{content:{type:'string',minLength:1}}},{required:['answers']}]};
for(const action of ['resume','retry']){
 const operation=paths[`/auto-review-batches/{id}/${action}`].post;
 operation.summary='恢复中断或重试剩余事项；补充background会重新全面审查，已有待答问题时必须提交当前questionId及回答';
 operation.requestBody.content['application/json'].schema=object({background,questionId:uuid,content:structuredAnswer.properties.content,answers:structuredAnswer.properties.answers},[]);
}
const agentEndpoints=[
 ['post','/contracts/{id}/agent-sessions','创建固定文件与材料版本的 Agent 会话',object({revision,content:str,clientKey:str},[])],
 ['get','/contracts/{id}/agent-sessions','列出合同各版本会话'],
 ['get','/agent-sessions/{id}','会话、消息、结果版本及状态；待答消息data.questions包含id/header/question/detail/options[{label,description}]/multiSelect，已答消息data.answers保留选择及其他文字'],
 ['post','/agent-sessions/{id}/messages','继续调查，创建新的结果版本',message],
 ['post','/agent-sessions/{id}/answers','回答当前必要问题并继续；结构化答案须覆盖全部问题，校验选项及单多选限制，陈旧问题返回409',structuredAnswer],
 ['post','/agent-sessions/{id}/cancel','停止当前轮次，保留工作',object({},[])],
 ['post','/agent-sessions/{id}/resume','通过官方持久会话继续，创建新结果版本',object({content:str,clientKey:str},[])],
 ['get','/agent-sessions/{id}/events','按 after 游标增量读取业务事件'],
 ['get','/agent-sessions/{id}/results/{reviewId}','读取指定结果版本及法务结论'],
 ['get','/agent/capabilities','公开预算、推理格式和检索配置状态'],
 ['get','/agent/system-skills','法务只读查看项目内置系统技能、适用范围、固定内容版本及必读范例；人工提升的系统技能在experiences中管理'],
 ['get','/agent/experiences','按部门权限查询技能、案例经验与整理记录；kind支持all/skill/experience/system，is_system标记人工提升的系统技能；服务端搜索、状态筛选与分页，生效数与待审核数单独统计'],
 ['get','/agent/experiences/{id}','知识详情：正式正文、待处理草稿、版本及审核意见、操作记录；永久删除后返回404'],
 ['post','/agent/experiences','人工创建知识草稿；法务固定本部门，管理员可指定部门；审核前不参与审查',object({kind:{enum:['skill','experience']},title:{type:'string',minLength:1,maxLength:200},description:{type:'string',minLength:1,maxLength:500},content:{type:'string',minLength:1,maxLength:12000},conditions:{type:'array',maxItems:20,items:{type:'string',minLength:1,maxLength:1000}},department:{type:'string',maxLength:200}},['kind','title','description','content'])],
 ['put','/agent/experiences/{id}','新增或更新唯一待处理草稿；待审核时锁定编辑，原正式版继续有效；revision不符返回409',object({revision,kind:{enum:['skill','experience']},title:{type:'string',minLength:1,maxLength:200},description:{type:'string',minLength:1,maxLength:500},content:{type:'string',minLength:1,maxLength:12000},conditions:{type:'array',maxItems:20,items:{type:'string',minLength:1,maxLength:1000}}},['revision','kind','title','description','content'])],
 ['delete','/agent/experiences/{id}','永久删除知识及全部草稿、版本正文；不影响同来源其他知识，保留原始处理、历史审查快照和无正文的删除审计',object({revision})],
 ...['submit','approve','reject','enable','disable'].map(action=>['post',`/agent/experiences/{id}/${action}`,({submit:'提交草稿审核并锁定编辑',approve:'审核通过并递增正式版本，允许本人审核；旧审查标记待复核',reject:'退回修改，note必填',enable:'启用已发布正式版；已撤销来源不可启用',disable:'单条停用并使旧审查上下文失效'})[action],object({revision,note:{type:'string',maxLength:3000,...(action==='reject'?{minLength:1}:{})}},action==='reject'?['revision','note']:['revision'])]),
 ...['promote','demote'].map(action=>['post',`/agent/experiences/{id}/${action}`,action==='promote'?'将无待处理草稿的生效审查技能设为系统技能；保留部门、适用条件、来源及正文版本，后续每轮强制加载；仅法务可操作':'将人工提升的系统技能切回审查技能；保留正文版本、来源、适用范围与启停状态，后续按需读取；两种切换均记录审计并使旧审查上下文失效',object({revision})]),
 ['get','/agent/experience-sources/{id}','查看有权限的整理来源、法务输入字段及生成内容'],
 ['post','/agent/experience-sources/{id}/revoke','撤销整个来源及全部派生知识，标记已引用结果；并发校验revision',object({revision,reason:{type:'string',minLength:1,maxLength:3000}})],
 ['post','/agent/experience-sources/{id}/retry','重试失败的自动整理；新生成内容为草稿',object({revision})],
 ['put','/settings/agent','管理员保存模型容量、预算、推理和加密检索密钥',object({maxRequests:{type:'integer',minimum:2,maximum:200},maxMinutes:{type:'integer',minimum:1,maximum:120},contextWindow:{type:'integer',minimum:8192},maxOutputTokens:{type:'integer',minimum:1024},thinkingFormat:{enum:['openai','deepseek','qwen','qwen-chat-template','zai']},reasoning:{type:'boolean'},searchKey:str,clearSearchKey:{type:'boolean'},expectedUpdatedAt:{type:['string','null']}},['maxRequests','maxMinutes','contextWindow','maxOutputTokens','thinkingFormat','reasoning'])],
 ['post','/settings/agent/test','官方 SDK 真实工具调用和连续回传兼容测试',object({},[])],
 ['get','/agent/evaluation-cases','人工风险与证据标注样本'],
 ['post','/agent/evaluation-cases','保存独立标注，绑定固定材料',object({name:str,reviewId:uuid,split:{enum:['development','holdout']},risks:{type:'array',items:object({id:str,title:str,severity:{enum:['high','medium','low']},evidence:{type:'array',items:object({versionId:uuid,blockId:str,quote:str})},expectedAdvice:str})}})],
 ['get','/agent/evaluations','风险、证据、改稿质量及运行成本记录'],
 ['post','/agent/evaluations','人工匹配风险并保存评测',object({caseId:uuid,reviewId:uuid,matches:{type:'array',items:object({riskId:str,findingId:uuid,evidenceCorrect:{type:'boolean'},adviceAcceptable:{type:'boolean'}})},cost:{type:['number','null']},costCurrency:str},['caseId','reviewId','matches'])],
];
for(const [method,url,summary,body]of agentEndpoints){const parameters=[...url.matchAll(/\{([^}]+)\}/g)].map(m=>({name:m[1],in:'path',required:true,schema:uuid}));if(url.endsWith('/events'))parameters.push({name:'after',in:'query',schema:{type:'integer',minimum:0,default:0}});paths[url]||={};paths[url][method]={summary,operationId:method+'_'+url.replace(/[^a-zA-Z0-9]+/g,'_'),security:[{sessionCookie:[]}],parameters,...(body?{requestBody:{required:true,content:{'application/json':{schema:body}}}}:{}),responses:{200:{description:'读取、保存或停止成功'},...(method==='post'?{201:{description:'标注或评测创建成功'},202:{description:'Agent 或自动整理已入队'}}:{}),400:{description:'输入无效'},401:{description:'需要登录'},403:{description:'权限或CSRF校验失败'},404:{description:'无权读取当前合同'},409:{description:'任务并发、文件版本或模型快照冲突'},422:{description:'证据无效或网关不兼容'},503:{description:'固定 Harness 尚未构建或工具注册不一致'}}};}
paths['/contracts/upload'].post.summary='上传后自动创建 Agent 审查，无需预分析、分类确认或审查点选择';
paths['/contracts/{id}/review-document'].get.parameters.push(...['versionId','reviewId'].map(name=>({name,in:'query',schema:uuid})));
paths['/contracts/{id}/review-document'].post.responses[200]=jsonResponse('已保存审阅文件，经验草稿仍须审核后生效',object({versionId:uuid,versionNo:{type:'integer'},saved:{type:'boolean'},learning:object({sourceId:{type:['string','null'],format:'uuid'},status:{enum:['queued','recorded','skipped']},message:str})}));
paths['/agent/experiences'].get.parameters.push(...Object.entries({q:{type:'string',maxLength:500,description:'标题、摘要、正文和适用条件的字面量搜索，包含待处理草稿'},kind:{enum:['all','skill','experience'],default:'all'},state:{enum:['all','active','disabled','unpublished'],default:'all'},review:{enum:['all','none','draft','pending','rejected'],default:'all'},page:{type:'integer',minimum:1,default:1},pageSize:{type:'integer',minimum:1,maximum:100,default:20}}).map(([name,schema])=>({name,in:'query',schema})));
paths['/agent/experiences'].get.responses[200]=jsonResponse('分页知识及整理记录；summary.pending为后台整理数，pendingReview为待审核知识数',object({memories:{type:'array',items:{type:'object',description:'正式字段、revision、draft_status、origin、可选draft、来源状态'}},total:{type:'integer'},page:{type:'integer'},pageSize:{type:'integer'},sources:{type:'array',items:{type:'object'}},sourceCount:{type:'integer'},pendingCount:{type:'integer'},summary:object({skills:{type:'integer'},experiences:{type:'integer'},sources:{type:'integer'},pending:{type:'integer'},pendingReview:{type:'integer'}}),legacyDisabled:{const:true}}));
const spec={openapi:'3.1.0',info:{title:'法律 Agent 合同预审工作台 API',version:'2.1.0',description:'官方固定版本 DeepSeek Harness Agent 会话。新任务不加载旧规则、旧技能和旧经验。手工与自动提炼知识均先保存草稿，审核后生效，支持逐条管理与永久删除。技术完成与法务结论独立，追问另存结果版本；历史审查快照及导出继续保留。'},servers:[{url:'/api'}],paths,components:{securitySchemes:{sessionCookie:{type:'apiKey',in:'cookie',name:'legal.sid'},officeJwt:{type:'http',scheme:'bearer',bearerFormat:'JWT',description:'HS256签名；也可放在回调body.token'}},schemas}};
fs.mkdirSync(path.resolve(__dirname,'../docs'),{recursive:true});fs.writeFileSync(path.resolve(__dirname,'../docs/openapi.json'),JSON.stringify(spec,null,2)+'\n');console.log(`OpenAPI written: ${Object.values(paths).reduce((n,p)=>n+Object.keys(p).length,0)} operations`);
