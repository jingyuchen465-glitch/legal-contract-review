<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { api, role, label, time } from './api';
import { ElMessage } from 'element-plus/es/components/message/index.mjs';
import { uploadAccept, uploadHint, uploadProblem } from './upload-formats';

const router = useRouter(), contracts = ref([]), catalog = ref([]), busy = ref(false), showUpload = ref(false), query = ref(''), state = ref(''), source = ref(''), intakeMode = ref(''), type = ref(''), reviewer = ref(''), reviewers = ref([]), page = ref(1), total = ref(0);
const files = ref([]), form = ref({ ourEntity: '', ourSide: '', perspective: '', purpose: '' }), completed = ref(0);
const filtered = computed(() => contracts.value);
const stats = computed(() => [{ name: '筛选结果', n: total.value }, { name: '本页待法务处理', n: contracts.value.filter(c => ['pending_review', 'in_review'].includes(c.legal_status) && c.review?.status === 'completed').length }, { name: '本页 AI 正在处理', n: contracts.value.filter(c => ['queued', 'running'].includes(c.review?.status)).length }, { name: '本页需补件 / 处理', n: contracts.value.filter(c => ['waiting_input', 'failed'].includes(c.review?.status)).length }]);
const processingReason = c => ({CONVERTER_UNAVAILABLE:'格式转换服务未连接',CONVERTER_NOT_CONFIGURED:'格式转换服务未配置',CONVERSION_TIMEOUT:'格式转换超时',MODEL_HTTP_408:'模型服务响应超时',MODEL_NETWORK:'模型连接失败或超时'}[c.preanalysis?.error_code] || c.preanalysis?.error_message || '请进入合同查看原因');
const processing = c => c.entryType==='dingtalk_intake' || c.intakeStatus && c.intakeStatus!=='confirmed' ? '待确认审批分组' : label(c.review?.status);
const typeName = c => {
  const classification = c.classification;
  const currentClassification = classification && (!classification.versionId || classification.versionId === c.current_version_id);
  if (currentClassification && classification.confirmed) return classification.typeName || catalog.value.flatMap(c => c.types).find(t => t.id === classification.typeId)?.name || '未识别类型';
  const review = c.review;
  if (review?.engine === 'harness-v1' && review.status === 'completed' && review.version_id === c.current_version_id && review.agent_result?.contractType?.trim()) return review.agent_result.contractType.trim();
  if (currentClassification) return classification.typeName || catalog.value.flatMap(c => c.types).find(t => t.id === classification.typeId)?.name || '未识别类型';
  return review?.status === 'completed' ? '未识别类型' : '待 Agent 识别';
};
let loadSequence = 0;
async function load(quiet = false) { const sequence = ++loadSequence; const params = new URLSearchParams({view:'main',page:String(page.value),q:query.value,status:state.value,source:source.value,intakeMode:intakeMode.value,type:type.value,reviewer:reviewer.value}); for (const [key,value] of [...params]) if (!value) params.delete(key); const data = await api('/contracts?'+params, { quiet }); if (sequence === loadSequence) { contracts.value = data.items; total.value = data.total; } }
let searchTimer;
watch([query,state,source,intakeMode,type,reviewer], () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { if (page.value !== 1) page.value = 1; else load().catch(()=>{}); }, 250); });
watch(page, () => load().catch(()=>{}));
function selectFiles(e) { const selected = [...e.target.files], problem = uploadProblem(selected); if (problem) { ElMessage.error(problem); e.target.value = ''; files.value = []; return; } files.value = selected; }
async function upload() {
  if (busy.value || !files.value.length) return;
  busy.value = true; completed.value = 0;
  const background = JSON.stringify(form.value), created = [];
  try {
    for (const file of [...files.value]) {
      const data = new FormData(); data.set('file', file); data.set('background', background); data.set('reviewFlow', 'agent');
      const result = await api('/contracts/upload', { method: 'POST', body: data });
      created.push(result.contract.id);
      completed.value++; files.value = files.value.filter(item => item !== file);
      if (result.archive?.status === 'failed') ElMessage.warning(result.archive.message);
    }
    showUpload.value = false; await load();
    if (created.length === 1) await router.push('/contracts/' + created[0]);
  } finally { busy.value = false; }
}
let timer;
onMounted(async () => { await load(); const data = await api('/catalog'); catalog.value = data.categories; if (role('legal')) reviewers.value = await api('/reviewers'); timer = setInterval(() => load(true).catch(() => {}), 5000); }); onUnmounted(() => { clearInterval(timer); clearTimeout(searchTimer); });
</script>
<template>
  <section class="page-heading"><div><div class="eyebrow">CONTRACT WORKSPACE</div><h1>合同与待办</h1><p>从接收到归档，跟踪每一份合同的审查进度。</p></div><div class="action-row"><router-link v-if="role('business','legal')" to="/auto-review" class="secondary-link">自动评审</router-link><router-link v-if="role('legal')" to="/reconciliation" class="secondary-link">补查待确认</router-link><button v-if="role('business','legal')" class="primary" @click="showUpload = true">＋ 提交合同</button></div></section>
  <div class="stat-grid"><div v-for="(s,i) in stats" :key="s.name" class="stat-card"><span>{{ s.name }}</span><strong>{{ s.n.toString().padStart(2,'0') }}</strong><i :class="'stat-line line-'+i"></i></div></div>
  <div class="panel"><div class="panel-heading"><h2>合同台账 <span class="count">{{ total }}</span></h2><button class="text-btn" @click="load()">↻ 刷新</button></div><div class="filter-row"><input v-model="query" class="search" placeholder="搜索合同名称、编号…" aria-label="搜索合同" /><select v-model="state" aria-label="法务状态"><option value="">全部法务状态</option><option v-for="s in ['pending_review','in_review','returned','finalized','archived']" :value="s" :key="s">{{ label(s) }}</option></select><select v-model="source" aria-label="来源"><option value="">全部来源</option><option value="manual">手动上传</option><option value="dingtalk">钉钉审批</option></select><select v-model="intakeMode" aria-label="收件方式"><option value="">全部收件方式</option><option value="live">实时收件</option><option value="reconciliation">历史补查</option><option value="manual">手动上传</option></select><select v-model="type" aria-label="合同类型"><option value="">全部合同类型</option><option v-for="t in catalog.flatMap(c=>c.types)" :value="t.id" :key="t.id">{{ t.name }}</option></select><select v-if="role('legal')" v-model="reviewer" aria-label="负责人"><option value="">全部负责人</option><option value="unassigned">未分配</option><option v-for="u in reviewers" :key="u.id" :value="u.id">{{ u.displayName }}</option></select></div>
    <div class="table-scroll"><table><thead><tr><th>合同名称 / 编号</th><th>合同类型</th><th>收件方式</th><th>AI 处理</th><th>法务流程</th><th>提交时间</th><th></th></tr></thead><tbody><tr v-for="c in filtered" :key="c.id" @click="router.push(c.entryType==='dingtalk_intake'?'/dingtalk/intakes/'+c.intakeId:'/contracts/'+c.id)" class="clickable"><td><strong class="contract-title">{{ c.title }}</strong><small class="mono">{{ c.number }}</small></td><td>{{ typeName(c) }}</td><td><span class="badge" :class="c.intake_mode">{{ c.intake_mode==='live'?'实时收件':c.intake_mode==='reconciliation'?'历史补查':'手动上传' }}</span></td><td><span class="badge" :class="c.review?.status">{{ processing(c) }}</span><small v-if="c.review?.snapshot?.reviewMode==='trial'">历史试审</small></td><td><span class="badge" :class="c.legal_status">{{ c.intakeStatus && c.intakeStatus!=='confirmed' ? '材料归属待确认' : label(c.legal_status) }}</span></td><td class="muted nowrap">{{ time(c.created_at) }}</td><td class="arrow">↗</td></tr></tbody></table></div>
    <div v-if="!filtered.length" class="empty-state"><span class="empty-icon">▤</span><h3>{{ contracts.length?'没有符合条件的合同':'合同工作空间已就绪' }}</h3><p>{{ contracts.length?'调整筛选条件查看其他合同。':'提交 PDF、Word、Excel 或 PPT，系统自动处理格式并保留原件。' }}</p><button v-if="role('business','legal') && !contracts.length" @click="showUpload=true">提交第一份合同</button></div>
  </div><div class="action-row" style="justify-content:flex-end;margin:16px 0"><span class="muted">共 {{ total }} 份 · 第 {{ page }} / {{ Math.max(1,Math.ceil(total/50)) }} 页</span><button :disabled="page<=1" @click="page--">上一页</button><button :disabled="page*50>=total" @click="page++">下一页</button></div><div class="notice subtle">上传即可开始审查。需要影响判断的背景时，Agent 会在对话中提问。</div>
  <el-dialog v-model="showUpload" title="提交合同" width="min(640px, calc(100vw - 32px))" class="upload-dialog" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy"><form @submit.prevent="upload" class="stack"><div class="notice">上传后 Agent 自动阅读和核查，可离开页面。下列背景可选填；缺少关键信息时会提问。每个文件分别创建合同任务，附件请在详情中补充。原件始终保留。</div><fieldset :disabled="busy" class="upload-fields stack"><label class="drop-zone">{{ uploadHint }}<input type="file" multiple :accept="uploadAccept" required @change="selectFiles" /><span v-if="files.length">已选 {{ files.length }} 份</span></label><label>我方为<select v-model="form.ourSide"><option value="">填写公司名称</option><option value="party_a">甲方</option><option value="party_b">乙方</option><option value="other">其他主体</option></select></label><label>我方主体<input v-model="form.ourEntity"  maxlength="200" :placeholder="['party_a','party_b'].includes(form.ourSide)?'可留空，按合同所列主体审查':'公司完整名称'" /></label><label>我方交易立场<input v-model="form.perspective" maxlength="200" placeholder="例如：采购方 / 委托仓储方" /></label><label>交易目的 / 重点检查项<textarea v-model="form.purpose" maxlength="3000" rows="3" placeholder="简述交易内容及需要重点关注的问题" /></label></fieldset><div class="dialog-actions"><span class="muted" v-if="busy">已提交 {{ completed }} / {{ completed + files.length }}</span><button class="primary" :disabled="busy || !files.length">{{ busy?'正在提交…':'上传并开始审查' }}</button></div></form></el-dialog>
</template>
<style scoped>
.processing-error{color:#b45309;max-width:190px;white-space:normal;line-height:1.5}.upload-fields{border:0;padding:0;margin:0;min-width:0}
.upload-dialog .muted{margin:0;line-height:1.7}
</style>
<style>
.upload-dialog.el-dialog{width:min(640px,calc(100vw - 32px));margin-top:5vh;margin-bottom:5vh}
.upload-dialog .el-dialog__body{max-height:calc(90vh - 100px);overflow-y:auto}
</style>
