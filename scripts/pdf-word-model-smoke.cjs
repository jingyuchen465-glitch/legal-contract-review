// Run only against an isolated database; credentials are read in memory from the configured gateway.
const path=require('node:path');
const fs=require('node:fs/promises');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const rootPath=path.resolve(__dirname,'..');
const load=n=>require(path.join(rootPath,'backend/pilot',n));
const {config}=load('config');
const {createDb}=load('db');
const {migrate}=load('cli');
const {providerConfig}=load('model');
const {createContract}=load('contracts');
const {processWordConversion}=load('word-conversions');
const storage=load('storage');
(async()=>{
 const root=createDb(),provider=await providerConfig(root),name='legal_pdf_acceptance_'+randomUUID().replaceAll('-','');
 let db;
 try{
  require('node:child_process').execFileSync('runuser',['-u','postgres','--','createdb','--owner',decodeURIComponent(new URL(config.databaseUrl).username),name],{stdio:'ignore'});const url=new URL(config.databaseUrl);url.pathname='/'+name;config.databaseUrl=url.href;config.env='test';config.pdfWord.enabled=true;config.model={...provider};
  config.converter={...config.converter,url:'http://127.0.0.1:8093',token:'pdf-word-synthetic-acceptance-token-20261105'};
  config.dataRoot=path.join(rootPath,'.local/acceptance-data',name);db=createDb();await migrate(db);await storage.initializeDirectories();
  const actor={id:randomUUID(),username:'synthetic-acceptance',roles:['admin'],display_name:'虚构验收账号',department:'测试'};
  await db('la_users').insert({...actor,roles:JSON.stringify(actor.roles),password_hash:'disabled-synthetic-account'});
  const results=[];
  for(const filename of process.env.PDF_ACCEPTANCE_FILES?.split(',')||['native-bilingual-table.pdf','scan-bilingual-table.pdf','mixed.pdf']){
   const data=await fs.readFile(path.join(rootPath,'.local/pdf-word/fixtures',filename));
   const upload=await db.transaction(trx=>createContract(trx,actor,{buffer:data,originalname:filename},{guidedReview:true,background:{ourEntity:'虚构甲公司',perspective:'采购方',purpose:'验证文档转换'}}));
   const extraction=await load('pdf-layout').extractionFor(db,upload.version),id=randomUUID();
   await db('la_word_conversions').insert({id,version_id:upload.version.id,extraction_id:extraction.id,created_by:actor.id,status:'queued'});
   console.log(JSON.stringify({stage:'starting',filename}));await processWordConversion(db,id);
   const job=await db('la_word_conversions').where({id}).first();
   if(job.status==='failed'){console.log(JSON.stringify({filename,status:job.status,errorCode:job.error_code,message:job.error_message}));throw new Error('ACCEPTANCE_CONVERSION_FAILED');}
   const parsed=load('parser').parseDocx(await storage.read(job.artifacts.docx.storage_key));const text=parsed.blocks.map(b=>b.text).join('\n');
   assert.ok(text.includes('12345.67'),'amount must be preserved');assert.ok(text.includes('400.25'),'table unit price must be preserved');assert.ok(text.includes('虚构甲公司'),'party must be preserved');
   assert.ok(text.includes('2026-11-05'),'date must be preserved');
   if(filename==='multipage-merged-landscape.pdf'){
    const preview=await storage.read(job.artifacts.pdf.storage_key),page=await load('pdf-layout').renderPage(preview,2);
    const left=page.nativeItems.find(n=>n.text.includes('第二页左栏')),right=page.nativeItems.find(n=>n.text.includes('第二页右栏'));
    assert.ok(left&&right,'both columns must remain readable');assert.ok(Math.abs(left.bbox[1]-right.bbox[1])<10,'column starts must stay aligned');
    const xml=new (require(require.resolve('adm-zip',{paths:[path.join(rootPath,'backend')]})))(await storage.read(job.artifacts.docx.storage_key)).readAsText('word/document.xml');
    assert.ok(xml.includes('w:vMerge'),'vertical merged cell must remain editable');
   }
   const cached=await load('pdf-layout').extract(db,upload.version,extraction,{render:()=>{throw Error('cached extraction must not render again');}});assert.ok(cached.document.extractionId);
   const output=path.join(rootPath,'.local/pdf-word/model-output',filename.replace('.pdf',''));await fs.mkdir(output,{recursive:true});
   for(const [kind,artifact]of Object.entries(job.artifacts))await fs.writeFile(path.join(output,kind==='report'?'quality.json':`converted.${kind}`),await storage.read(artifact.storage_key));
   results.push({filename,status:job.status,sourceHashUnchanged:storage.sha256(await storage.read(upload.version.storage_key))===upload.version.sha256,tableCells:parsed.blocks.filter(b=>b.kind==='table_cell').length,quality:job.quality});
   console.log(JSON.stringify({stage:'completed',filename,status:job.status,tableCells:results.at(-1).tableCells}));
  }
  await fs.writeFile(path.join(rootPath,'.local/pdf-word/model-smoke-result.json'),JSON.stringify({isolatedDatabase:true,fictionalDocuments:true,realModel:provider.name,results,passed:true},null,2));
  console.log('REAL_MODEL_ACCEPTANCE_PASSED');
 }finally{
  await db?.destroy();await root.raw('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ? AND pid <> pg_backend_pid()',[name]);await root.raw(`DROP DATABASE IF EXISTS "${name}"`);await root.destroy();
 }
})().catch(e=>{console.error(e.code||e.message);process.exitCode=1;});
