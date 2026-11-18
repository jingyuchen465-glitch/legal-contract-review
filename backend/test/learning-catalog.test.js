const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {config}=require('../pilot/config');
const {catalog}=require('../pilot/catalog');
const {createGateway}=require('../pilot/model');
const {mergeGroups}=require('../pilot/learning-merge');
const {cumulativeItems,itemChanges,signature,publicVersion,applies,skillBatches}=require('../pilot/knowledge-catalog');
const {matchSkills,validatePack}=require('../pilot/skills');
const original=config.learningCatalog.enabled;before(()=>{config.learningCatalog.enabled=true;});after(()=>{config.learningCatalog.enabled=original;});
const method=id=>({id,title:'方法'+id,method:'核对合同中的具体付款及交付安排。',conditions:[],exclusions:[],examples:[],sourceIds:[],requiredRules:[]});
async function withGateway(respond,fn){const saved={...config.model};Object.assign(config.model,{baseUrl:'http://localhost:9999/v1',name:'catalog-fixture',key:'fixture'});try{await fn(createGateway(null,{fetchImpl:async(_,request)=>{const messages=JSON.parse(request.body).messages;return Response.json({choices:[{message:{content:JSON.stringify(await respond(JSON.parse(messages[1].content),messages[0].content))}}]});}}));}finally{Object.assign(config.model,saved);}}
test('cumulative updates preserve unrelated items; only explicit removals remove stable ids',()=>{
 const base=[method('a'),method('b')];const next=cumulativeItems(base,[method('c')]);assert.deepEqual(next.map(x=>x.id),['a','b','c']);
 const updated=cumulativeItems(next,[{...method('a'),method:'更新起算日期核对'}]);assert.equal(updated.length,3);assert.equal(updated[1].method,base[1].method);assert.equal(itemChanges(next,updated).updated,1);
 assert.deepEqual(cumulativeItems(updated,[],['b']).map(x=>x.id),['a','c']);assert.throws(()=>cumulativeItems(base,[method('a')],['a']),{code:'ITEM_OPERATION_CONFLICT'});
});
test('history labels distinguish replaced snapshots from an explicit retirement',()=>{
 const old={id:'v1',state:'retired'},next={id:'v2',state:'published',base_version_id:'v1'};assert.equal(publicVersion(old,[old,next]).displayState,'historical');assert.equal(publicVersion({...old,state_reason:'主动停用'},[old,next]).displayState,'retired');
});
test('41 skills survive validation and batching; only the affected rule dependency is excluded',()=>{
 const skills=Array.from({length:41},(_,i)=>method(String(i))),pack={id:'p',pack_id:'review-skill-warehouse',name:'海外仓方法',state:'published',scope:{level:'type',typeIds:['warehouse']},skills};assert.equal(validatePack(pack).skills.length,41);assert.equal(skillBatches([pack]).flatMap(b=>b.flatMap(p=>p.skills)).length,41);
 const r={id:'payment',instruction:'验收后付款'};pack.skills[0].requiredRules=[{packId:'warehouse',ruleId:r.id,signature:signature(r)}];
 const compatible=matchSkills({typeId:'warehouse',tags:['转租']},[pack],[{id:'new-pack-version',packId:'warehouse',ruleSignatures:{payment:signature(r)}}]);assert.equal(compatible[0].skills.length,41);
 const changed=matchSkills({typeId:'warehouse',tags:['转租']},[pack],[{id:'next',packId:'warehouse',ruleSignatures:{payment:signature({...r,instruction:'交付前付款'})}}]);assert.equal(changed[0].skills.length,40);assert.equal(changed[0].excludedSkills[0].id,'0');
 assert.equal(applies({id:'builtin/warehouse/inventory'},{typeId:'warehouse',tags:['场地租赁','转租']}),false);
 assert.equal(applies({id:'inventory'},{typeId:'warehouse',tags:['仓储服务']}),true);
});
test('full-document merge retains unique checkpoints and evidence, remaps rule dependencies, rejects silent omissions',()=>{
 const p=(key,kind='skill')=>({key,kind,scope:'type',title:'费用核对',method:kind==='skill'?'检查'+key:'',instruction:kind==='rule'?'费用标准':'',reason:key,conditions:[key],exclusions:[],examples:[],evidence:[{blockId:key,quote:key}],findingIds:[],dependsOn:[]});
 const a=p('a'),b={...p('b'),dependsOn:['r']},r=p('r','rule');const grouped={groups:[{memberKeys:['a','b'],disposition:'new'},{memberKeys:['r'],disposition:'new'}]};const result=mergeGroups(grouped,[a,b,r]);assert.equal(result.length,2);assert.equal(result[0].evidence.length,2);assert.match(result[0].method,/检查a/);assert.match(result[0].method,/检查b/);assert.deepEqual(result[0].dependsOn,['merged:1']);assert.throws(()=>mergeGroups({groups:[grouped.groups[0]]},[a,b,r]),{code:'LEARNING_OUTPUT_INVALID'});
 assert.throws(()=>mergeGroups({groups:[{memberKeys:['a','r'],disposition:'new'}]},[a,r]),{code:'LEARNING_OUTPUT_INVALID'});
});
test('all catalog subtypes can classify from literal contents and unknown does not become other',async()=>{
 for(const type of catalog.flatMap(c=>c.types))await withGateway(input=>({typeId:type.id,tags:type.id==='warehouse'?['场地租赁','转租']:[],reason:'根据交易标的和权责判断',uncertain:false,evidence:[{blockId:'b1',quote:'具体交易标的'}]}),async gateway=>assert.equal((await gateway.classify({blocks:[{id:'b1',text:'具体交易标的'}]})).typeId,type.id));
 await withGateway(()=>({typeId:'unknown',tags:[],reason:'无可识别正文',uncertain:true,evidence:[]}),async gateway=>assert.equal((await gateway.classify({blocks:[{id:'b1',text:'内容不完整'}]})).typeId,'unknown'));
});
test('long-contract classification synthesizes core transaction instead of boilerplate majority voting',async()=>{
 const document={blocks:Array.from({length:45},(_,i)=>({id:'b'+i,text:(i===0?'海外仓场地转租给承租方。':'通用付款及争议解决。')+'内容。'.repeat(400)}))};let parts=0,synthesis=0;
 await withGateway(input=>{if(input.parts){synthesis++;return {typeId:'warehouse',tags:['转租','场地租赁'],reason:'核心义务是提供海外仓场地',uncertain:false,evidence:[{blockId:'b0',quote:'海外仓场地转租给承租方。'}]};}parts++;const core=input.blocks.some(b=>b.id==='b0');return {typeId:core?'warehouse':'other',tags:core?['转租']:[],reason:core?'提供海外仓场地':'只有通用条款',uncertain:!core,evidence:[{blockId:input.blocks[0].id,quote:input.blocks[0].text.slice(0,10)}]};},async gateway=>{const result=await gateway.classify(document);assert.equal(result.typeId,'warehouse');assert.ok(parts>=3);assert.equal(synthesis,1);});
});
