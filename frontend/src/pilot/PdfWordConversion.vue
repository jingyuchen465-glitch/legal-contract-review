<script setup>
import { ref, computed, watch, onUnmounted } from 'vue';
import { api, role } from './api';
const props=defineProps({version:Object,contract:Object});
const emit=defineEmits(['created']);
const enabled=ref(false),job=ref(null),busy=ref(false),error=ref(''),compare=ref(false),acknowledged=ref(false);
let timer,sequence=0;
const ready=computed(()=>['completed','needs_verification'].includes(job.value?.status));
const running=computed(()=>job.value&&['queued','recognizing','typesetting','verifying'].includes(job.value.status));
const names={queued:'等待处理',recognizing:'识别正文和表格',typesetting:'生成 Word 排版',verifying:'核验转换内容',completed:'转换完成',needs_verification:'转换稿已生成，需核对',failed:'转换失败'};
async function refresh(id,token){try{const result=await api(`/word-conversions/${id}`,{quiet:true});if(token!==sequence)return;job.value=result;if(['queued','recognizing','typesetting','verifying'].includes(result.status))timer=setTimeout(()=>refresh(id,token),3000);}catch(e){if(token===sequence)error.value=e.message;}}
async function perform(action){if(busy.value)return;busy.value=true;error.value='';try{await action();}catch(e){error.value=e.message;}finally{busy.value=false;}}
function follow(value){clearTimeout(timer);job.value=value;if(['queued','recognizing','typesetting','verifying'].includes(value.status))timer=setTimeout(()=>refresh(value.id,sequence),2000);}
const create=()=>perform(async()=>follow(await api(`/versions/${props.version.id}/word-conversions`,{method:'POST',body:{},quiet:true})));
const retry=()=>perform(async()=>{await api(`/word-conversions/${job.value.id}/retry`,{method:'POST',body:{},quiet:true});follow({...job.value,status:'queued',message:null});});
const adopt=()=>perform(async()=>{const result=await api(`/contracts/${props.contract.id}/versions/from-conversion`,{method:'POST',body:{conversionId:job.value.id,revision:props.contract.revision,acknowledged:acknowledged.value},quiet:true});emit('created',result);});
watch(()=>props.version?.id,async id=>{const token=++sequence;clearTimeout(timer);job.value=null;compare.value=false;acknowledged.value=false;error.value='';if(!id)return;try{const capabilities=await api('/word-conversion-capabilities',{quiet:true});const result=await api(`/versions/${id}/word-conversions`,{quiet:true});if(token!==sequence)return;enabled.value=capabilities.enabled;if(result.jobs.length)follow(result.jobs[0]);}catch(e){if(token===sequence)error.value=e.message;}},{immediate:true});
onUnmounted(()=>{sequence++;clearTimeout(timer);});
</script>

<template>
  <section v-if="enabled||job" class="pdf-word panel">
    <div class="pdf-word-actions"><b>PDF 转可编辑 Word</b><span>保留原件，生成正文、表格可编辑的转换副本</span><button v-if="enabled&&!job&&role('business','legal')" :disabled="busy" @click="create">生成可编辑 Word</button><span v-if="job" role="status">{{ names[job.status] }}<template v-if="running"> · 已识别 {{ job.completedPages }}/{{ job.pageCount||'—' }} 页</template></span><button v-if="job?.status==='failed'&&enabled&&role('business','legal')" :disabled="busy" @click="retry">重试失败部分</button></div>
    <p v-if="error||job?.message" class="error-text" role="alert">{{ error||job.message }}</p>
    <template v-if="ready">
      <p>请对照原件核对金额、主体、日期、表格和分页。图片、签章为原件图像副本。</p>
      <div class="pdf-word-actions"><a :href="job.artifacts.docx.url">下载 Word 副本</a><a :href="job.artifacts.report.url">下载核验说明</a><button @click="compare=!compare">{{ compare?'收起对照':'对照原件与转换稿' }}</button></div>
      <details v-if="job.quality?.issues?.length"><summary>查看需核对内容（{{ job.quality.issues.length }} 项）</summary><ul><li v-for="(issue,index) in job.quality.issues" :key="index">{{ issue.page?`第 ${issue.page} 页：`:'' }}{{ issue.reason }}</li></ul></details>
      <div v-if="compare" class="pdf-word-compare"><div><p>原始 PDF</p><iframe :src="`/api/files/${version.id}`" title="原始 PDF" /></div><div><p>Word 排版预览</p><iframe :src="job.artifacts.pdf.url" title="转换后的 Word 排版预览" /></div></div>
      <div v-if="role('business','legal')&&contract.current_version_id===version.id&&version.kind==='contract'" class="pdf-word-actions"><label><input v-model="acknowledged" type="checkbox" />已对照原件核对，接受以转换稿创建新版本</label><button :disabled="busy||!acknowledged" @click="adopt">创建 Word 版本并编辑</button><small>新版本进入现有预审流程，原 PDF 的历史意见与结论保留。</small></div>
    </template>
  </section>
</template>

<style scoped>
.pdf-word{margin:12px 0;padding:16px}.pdf-word-actions{display:flex;align-items:center;flex-wrap:wrap;gap:12px}.pdf-word p{margin:10px 0}.pdf-word details{margin:12px 0}.pdf-word-compare{display:grid;grid-template-columns:1fr 1fr;gap:16px}.pdf-word-compare iframe{width:100%;height:65vh;border:1px solid #d9e0e8}.pdf-word small{color:#667085}@media(max-width:900px){.pdf-word-compare{grid-template-columns:1fr}}
</style>
