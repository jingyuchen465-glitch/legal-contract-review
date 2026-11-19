const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { validateGroups } = require('../pilot/joint-intake');
const { validateComparison, namespaced, rules, evidenceForFile } = require('../pilot/joint-review');
const { groupFindings } = require('../pilot/finding-groups');
const a=randomUUID(),b=randomUUID(),v1=randomUUID(),v2=randomUUID();
const docs=[a,b].map(id=>({id,present:true,status:'collected',version:{parsed:{blocks:[{id:'b1',text:'正文'}]}}}));
test('group assignment requires a unique main, no foreign or repeated material, complete allocation and readable files',()=>{
 const g={name:'组',mainDocumentId:a,materials:[{documentId:b,role:'supplement'}]};
 assert.equal(validateGroups({groups:[g]},docs,true).groups.length,1);
 assert.throws(()=>validateGroups({groups:[g,g]},docs,true),e=>e.code==='DUPLICATE_MAIN');
 assert.throws(()=>validateGroups({groups:[{...g,materials:[{documentId:a,role:'reference'}]}]},docs,true),e=>e.code==='DUPLICATE_MATERIAL');
 assert.throws(()=>validateGroups({groups:[{...g,materials:[]}]},docs,true),e=>e.code==='UNASSIGNED_DOCUMENTS');
 assert.throws(()=>validateGroups({groups:[{...g,mainDocumentId:randomUUID()}]},docs,true),e=>e.code==='FOREIGN_DOCUMENT');
 assert.throws(()=>validateGroups({groups:[g]},[docs[0],{...docs[1],present:false}],true),e=>e.code==='JOINT_DOCUMENT_UNAVAILABLE');
});
test('cross-file effects require two different source files and precedence requires a quoted basis',()=>{
 const sources=[{versionId:v1,blocks:[{id:'b1',text:'30日付款'}]},{versionId:v2,blocks:[{id:'b1',text:'60日付款'}]}];
 const blocks=sources.flatMap(namespaced),ref=i=>({blockId:blocks[i].id,quote:blocks[i].text});
 const value={checks:rules.map(r=>({ruleId:r.id,status:'uncertain',kind:'uncertain',severity:'high',reason:'待核实',suggestion:'补充明确约定',evidence:[ref(0),ref(1)],legalRefIds:[]})),relations:['amendments','amounts_terms','precedence'].map(category=>({category,effect:'uncertain',before:[ref(0)],after:[ref(1)],basis:[],explanation:'待确认',applicableText:''})),suggestions:[]};
 assert.equal(validateComparison(value,blocks,sources).relations.length,3);
 const same=structuredClone(value);same.relations[0].effect='conflict';same.relations[0].after=[ref(0)];assert.throws(()=>validateComparison(same,blocks,sources),e=>e.code==='INVALID_EVIDENCE');
 const precedence=structuredClone(value);precedence.relations[2].effect='replace';assert.throws(()=>validateComparison(precedence,blocks,sources),e=>e.code==='INVALID_EVIDENCE');
 const foreign=structuredClone(value);foreign.suggestions=[{versionId:randomUUID(),text:'错误文件'}];assert.throws(()=>validateComparison(foreign,blocks,sources),e=>e.code==='INVALID_EVIDENCE');
});
test('same block numbers never merge across documents and file exports keep only local references',async()=>{
 const finding={id:'a',rule_id:'x',check_status:'fail',kind:'clause',reason:'风险',suggestion:'建议',severity:'high',evidence:[{versionId:v1,blockId:'b1',quote:'相同原文'}],legal_refs:[]};
 const other={...finding,id:'b',evidence:[{versionId:v2,blockId:'b1',quote:'相同原文'}]};
 assert.equal(groupFindings([finding,other]).length,2);assert.deepEqual(evidenceForFile([finding,other],v2,v1).map(f=>f.id),['b']);
 const { fileFindings }=await import('../../frontend/src/pilot/joint-documents.mjs');assert.deepEqual(fileFindings([finding,other],v2,v1).map(f=>f.id),['b']);
 assert.equal(evidenceForFile([{...finding,evidence:[]}],v2,v1).length,0);
});
test('AI grouping accepts string or array explanations without changing document identity validation',async()=>{
 const {config}=require('../pilot/config'),old=config.model;config.model={...old,baseUrl:'https://fixture.example',name:'fixture',key:'fixture'};
 try{const gateway=require('../pilot/model').createGateway(null,{fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({groups:[{name:'组',mainDocumentId:a,materials:[{documentId:b,role:'reference'}]}],excluded:[],notes:['说明一','说明二']})}}]})})});const result=await gateway.groupDocuments([{documentId:a},{documentId:b}],[]);assert.equal(result.notes,'说明一\n说明二');assert.equal(result.groups[0].mainDocumentId,a);}finally{config.model=old;}
});
