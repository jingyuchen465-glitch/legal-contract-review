// Temporary real-OnlyOffice acceptance server with a disposable database and fictional files.
const fs=require('node:fs/promises'),path=require('node:path'),{randomUUID}=require('node:crypto');
const base=path.resolve(__dirname,'..'),load=n=>require(path.join(base,'backend/pilot',n));
const {config}=load('config'),{createDb}=load('db');
(async()=>{
 const root=createDb(),provider=await load('model').providerConfig(root),name='legal_pdf_office_'+randomUUID().replaceAll('-','');
 require('node:child_process').execFileSync('runuser',['-u','postgres','--','createdb','--owner',decodeURIComponent(new URL(config.databaseUrl).username),name],{stdio:'ignore'});
 const url=new URL(config.databaseUrl);url.pathname='/'+name;config.databaseUrl=url.href;config.env='test';config.publicUrl='http://127.0.0.1:18195';config.model={...provider};config.pdfWord.enabled=true;config.dataRoot=path.join(base,'.local/office-data',name);config.office.backendUrl='http://172.20.0.1:18095';
 const db=createDb();await load('cli').migrate(db);await load('storage').initializeDirectories();
 const password=randomUUID()+'-fixture',actor={id:randomUUID(),username:'pdf-office-acceptance',display_name:'PDF虚构验收账号',roles:['admin'],department:'测试'};
 await db('la_users').insert({...actor,roles:JSON.stringify(actor.roles),password_hash:await load('auth').hashPassword(password)});
 const fixture=process.env.PDF_OFFICE_FIXTURE||'native-bilingual-table';
 const buffer=await fs.readFile(path.join(base,'.local/pdf-word/fixtures',fixture+'.pdf'));
 const uploaded=await db.transaction(trx=>load('contracts').createContract(trx,actor,{buffer,originalname:'虚构转换验收.pdf'},{guidedReview:true,background:{ourEntity:'虚构甲公司',perspective:'采购方',purpose:'PDF编辑验证'}}));
 const e=await load('pdf-layout').extractionFor(db,uploaded.version),id=randomUUID(),artifacts={};
 for(const [kind,name] of [['docx','converted.docx'],['pdf','converted.pdf'],['report','quality.json']]){const data=await fs.readFile(path.join(base,'.local/pdf-word/model-output',fixture,name));artifacts[kind]={storage_key:await load('storage').put(data,uploaded.contract.id,`${uploaded.version.id}/qa-derived`,name),sha256:load('storage').sha256(data),size:data.length};}
 const quality=JSON.parse((await load('storage').read(artifacts.report.storage_key)).toString());
 await db('la_word_conversions').insert({id,version_id:uploaded.version.id,extraction_id:e.id,created_by:actor.id,status:'needs_verification',completed_pages:1,artifacts:JSON.stringify(artifacts),quality:JSON.stringify(quality)});
 const runId=randomUUID();await db('la_reviews').insert({id:runId,contract_id:uploaded.contract.id,version_id:uploaded.version.id,created_by:actor.id,status:'completed',stage:'completed',progress:100,snapshot:JSON.stringify({reviewMode:'formal',rules:[],knowledge:[]}),coverage:JSON.stringify({complete:true,totalRules:0,checkedRules:0})});
 await db('la_contracts').where({id:uploaded.contract.id}).update({current_review_id:runId,current_preanalysis_id:null,classification:JSON.stringify({typeId:'procurement',tags:[],confirmed:true,versionId:uploaded.version.id})});
 const handle=load('app').createApp(db),server=handle.app.listen(18095,'0.0.0.0');
 const info={url:config.publicUrl,username:actor.username,password,contractId:uploaded.contract.id,sourceVersionId:uploaded.version.id,conversionId:id};
 await fs.writeFile(path.join(base,'.local/pdf-word/office-access.json'),JSON.stringify(info),{mode:0o600});console.log('ISOLATED_PDF_OFFICE_QA_READY');
 let closing=false;const stop=async()=>{if(closing)return;closing=true;server.close();await handle.close();await db.destroy();await root.raw('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=? AND pid<>pg_backend_pid()',[name]);await root.raw(`DROP DATABASE "${name}"`);await root.destroy();process.exit(0);};process.on('SIGTERM',stop);process.on('SIGINT',stop);
})().catch(e=>{console.error(e.code||e.message);process.exit(1);});
