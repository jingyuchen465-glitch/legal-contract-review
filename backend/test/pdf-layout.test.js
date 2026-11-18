const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validateLayout,vision,recognizePage}=require('../pilot/pdf-layout');
const {config}=require('../pilot/config');
const {publicModelSnapshot}=require('../pilot/model');
const page={width:600,height:800,pageCount:1,image:'test',nativeItems:[],imageRegions:[[0,0,1000,1000]]};
const paragraph={kind:'paragraph',bbox:[20,20,800,30],text:'Amount: 12345.67'};
test('mixed PDF pages trigger OCR even when selectable text is present',async()=>{
 const PDFDocument=require('pdfkit'),{parsePdf}=require('../pilot/parser');
 const doc=new PDFDocument({size:[600,800],margin:20}),parts=[];
 const data=new Promise((resolve,reject)=>{doc.on('data',p=>parts.push(p));doc.on('end',()=>resolve(Buffer.concat(parts)));doc.on('error',reject);});
 doc.text('Native heading');doc.image(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'),20,100,{width:300,height:200});doc.end();
 let called=0;const result=await parsePdf(await data,async()=>{called++;return {width:600,height:800,blocks:[{text:'Native heading and scanned clause',bbox:[20,20,500,300],confidence:1}]};},{detectMixed:true});
 assert.equal(called,1);assert.equal(result.blocks.length,1);assert.match(result.blocks[0].text,/scanned clause/);
});
test('native PDF text omitted by vision is preserved with an explicit warning',()=>{
 const result=validateLayout({blocks:[paragraph]}, {...page,nativeItems:[{id:'n1',text:'附加约定：退款',bbox:[20,100,800,30]}]},1);
 assert.equal(result.blocks[1].text,'附加约定：退款');assert.equal(result.issues.length,1);
});
test('table cells must completely cover the grid once, with valid merged ranges',()=>{
 const table={kind:'table',bbox:[0,0,900,500],rows:2,columns:2,cells:[{row:0,column:0,rowSpan:1,colSpan:2,text:'标题'},{row:1,column:0,text:'金额'},{row:1,column:1,text:'12345.67'}]};
 assert.equal(validateLayout({blocks:[table]},page,1).blocks[0].cells.length,3);
 assert.throws(()=>validateLayout({blocks:[{...table,cells:[...table.cells,{row:0,column:1,text:'重复'}]}]},page,1),{code:'PDF_LAYOUT_INVALID'});
 assert.throws(()=>validateLayout({blocks:[{...table,cells:table.cells.slice(0,1)}]},page,1),{code:'PDF_LAYOUT_INVALID'});
});
test('full page image without editable text cannot masquerade as conversion success',()=>{
 assert.throws(()=>validateLayout({blocks:[{kind:'image',bbox:[0,0,1000,1000]}]},page,1),{code:'PDF_TEXT_UNREADABLE'});
 assert.throws(()=>validateLayout({blocks:[{...paragraph,bbox:[900,0,900,20]}]},page,1),{code:'PDF_LAYOUT_INVALID'});
});
test('recognition fixes only the bad page and performs an additional image/content check',async()=>{
 let calls=0;
 const result=await recognizePage(null,Buffer.from('test'),1,{}, {render:async()=>page,vision:async()=>{calls++;if(calls===1)return {result:{blocks:[{...paragraph,bbox:[-1,0,1,1]}]}};if(calls===2)return {result:{blocks:[paragraph]}};return {result:{issues:['日期模糊，需核对']}};}});
 assert.equal(calls,3);assert.deepEqual(result.issues,['日期模糊，需核对']);
});
test('vision retries transient rate limits after Retry-After and rejects output truncation',async()=>{
 const old={...config.model};Object.assign(config.model,{name:'test-vision',baseUrl:'https://example.invalid/v1',key:'test-only'});
 try{let calls=0;const waits=[];const pinned=publicModelSnapshot(config.model);
 const answer=await vision(null,'test','read',{},pinned,{sleep:async ms=>waits.push(ms),fetchImpl:async()=>++calls===1?new Response('{}',{status:429,headers:{'retry-after':'2'}}):Response.json({choices:[{finish_reason:'stop',message:{content:'{"ok":true}'}}]})});
 assert.equal(answer.result.ok,true);assert.equal(answer.usage.retryCount,1);assert.deepEqual(waits,[2000]);
 await assert.rejects(()=>vision(null,'test','read',{},pinned,{fetchImpl:async()=>Response.json({choices:[{finish_reason:'length',message:{content:'{}'}}]})}),{code:'PDF_OUTPUT_TRUNCATED'});
 }finally{Object.assign(config.model,old);}
});
