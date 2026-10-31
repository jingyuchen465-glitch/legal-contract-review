const crypto=require('node:crypto');
const { MilvusClient, DataType }=require('@zilliz/milvus2-sdk-node');
const { config }=require('./config');
const { providerConfig,requestJson,publicModelSnapshot,assertModelSnapshot }=require('./model');
const { chunks }=require('./parser');
const { fail }=require('./errors');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
async function retrieveKnowledge(db,document,matched,{fetchImpl=fetch,trace}={}){
  if(!matched.knowledge.length)return{knowledge:[],retrieval:{mode:'no_published_material',ids:[]}};
  if(!process.env.MILVUS_ADDRESS||!config.embeddingModel){
    if(matched.knowledge.reduce((n,k)=>n+k.content.length,0)>24000)fail(422,'KNOWLEDGE_RETRIEVAL_REQUIRED','已发布资料过长，请配置 Embedding 与 Milvus 检索');
    return{knowledge:matched.knowledge,retrieval:{mode:'complete_published_material',ids:matched.knowledge.map(k=>k.id)}};
  }
  const provider=await providerConfig(db);if(!provider.key||!provider.baseUrl)fail(422,'EMBEDDING_NOT_CONFIGURED','检索所需模型网关尚未配置');
  const pinnedProvider=publicModelSnapshot(provider), assertProvider=async()=>assertModelSnapshot(await providerConfig(db),pinnedProvider);
  async function embed(text){await assertProvider();const key=hash(`${pinnedProvider.configSignature}:${config.embeddingModel}:${text}`),cached=await db('la_embedding_cache').where({hash:key}).first();if(cached)return cached.vector;
    const start=Date.now();const response=await requestJson(`${provider.baseUrl}/embeddings`,provider.key,{model:config.embeddingModel,input:text},{fetchImpl,beforeAttempt:assertProvider,afterResponse:assertProvider});const vector=response.data?.[0]?.embedding;
    if(!Array.isArray(vector)||!vector.length||vector.some(n=>!Number.isFinite(n)))fail(422,'INVALID_EMBEDDING','Embedding 返回结构无效');
    await db('la_embedding_cache').insert({hash:key,model:config.embeddingModel,vector:JSON.stringify(vector)}).onConflict('hash').ignore();await trace?.({label:'embedding',model:config.embeddingModel,elapsedMs:Date.now()-start,usage:response.usage});return vector;
  }
  const client=new MilvusClient({address:process.env.MILVUS_ADDRESS,token:process.env.MILVUS_TOKEN||undefined,timeout:30000});
  try{
    const rows=[];for(const k of matched.knowledge){const vector=await embed(`${k.title}\n${k.content}`);rows.push({id:hash(`${k.id}:${JSON.stringify(k)}:${config.embeddingModel}`),vector});}
    const dim=rows[0].vector.length;if(rows.some(r=>r.vector.length!==dim))fail(422,'EMBEDDING_DIMENSION','Embedding 维度不一致');
    const collection=`legal_published_${hash(provider.baseUrl+config.embeddingModel).slice(0,12)}_${dim}`;
    if(!(await client.hasCollection({collection_name:collection})).value){
      await client.createCollection({collection_name:collection,fields:[{name:'id',data_type:DataType.VarChar,is_primary_key:true,max_length:64},{name:'vector',data_type:DataType.FloatVector,dim}]});
      await client.createIndex({collection_name:collection,field_name:'vector',index_type:'AUTOINDEX',metric_type:'COSINE',params:{}});
    }
    const upsert=await client.upsert({collection_name:collection,data:rows});if(upsert.status?.error_code&&upsert.status.error_code!=='Success')throw new Error('MILVUS_UPSERT');
    await client.loadCollectionSync({collection_name:collection});const ids=new Set();
    for(const part of chunks(document)){const vector=await embed(part.map(b=>b.text).join('\n'));const result=await client.search({collection_name:collection,data:[vector],anns_field:'vector',metric_type:'COSINE',limit:Math.min(12,rows.length),filter:`id in [${rows.map(r=>JSON.stringify(r.id)).join(',')}]`,output_fields:['id'],consistency_level:'Strong'});for(const row of result.results||[])ids.add(row.id);}
    const knowledge=matched.knowledge.filter((k,n)=>ids.has(rows[n].id));if(!knowledge.length)fail(422,'KNOWLEDGE_RETRIEVAL_EMPTY','未召回可追溯资料，请人工处理');
    return{knowledge,retrieval:{mode:'milvus',embeddingModel:config.embeddingModel,collection,ids:knowledge.map(k=>k.id)}};
  }catch(e){if(e.code)throw e;fail(503,'KNOWLEDGE_RETRIEVAL_FAILED','Milvus 检索暂不可用，请检查内部服务');}finally{client.closeConnection();}
}
module.exports={retrieveKnowledge};
