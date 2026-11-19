<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRoute, onBeforeRouteLeave } from 'vue-router';
import { api, role, time } from './api';
import { uploadAccept } from './upload-formats';
const route = useRoute(), intake = ref(), selection = ref({ groups: [], excluded: [] }), baseline = ref(''), busy = ref(false), error = ref(''), message = ref('');
let timer;
const dirty = computed(() => JSON.stringify(selection.value) !== baseline.value);
const names = { collecting:'正在收取', queued:'等待后台解析', analyzing:'解析与建议分组中', ready:'待确认分组', failed:'分析失败，可手动分组', confirmed:'已确认分组' };
const roles = { supplement:'补充协议', schedule:'价格 / 履约附件', reference:'其他参考材料' };
const used = id => selection.value.groups.some(g => g.mainDocumentId === id || g.materials.some(m => m.documentId === id));
const excluded = id => selection.value.excluded.find(e => e.documentId === id);
const unassigned = computed(() => intake.value?.documents.filter(d => !used(d.id) && !excluded(d.id)) || []);
async function load(poll = false) {
  try {
    const next = await api('/dingtalk/intakes/' + route.params.id, { quiet: true });
    if (poll && (dirty.value || busy.value)) return;
    intake.value = next;
    const raw = next.draft || next.analysis || { groups: [], excluded: [] };
    selection.value = JSON.parse(JSON.stringify({ groups: raw.groups || [], excluded: raw.excluded || [] })); baseline.value = JSON.stringify(selection.value);
    error.value = '';
  } catch(e) { error.value = e.message; }
}
function addGroup() { selection.value.groups.push({ name:'新合同组', mainDocumentId:'', materials:[] }); }
function setMaterial(group, id, value) { group.materials = group.materials.filter(m => m.documentId !== id); if (value) group.materials.push({ documentId:id, role:value }); selection.value.excluded = selection.value.excluded.filter(e => !used(e.documentId)); }
function toggleExclude(doc, value) { selection.value.excluded = selection.value.excluded.filter(e => e.documentId !== doc.id); if(value) selection.value.excluded.push({ documentId:doc.id, reason:'' }); }
async function perform(fn, text) { if(busy.value)return; busy.value=true; error.value=''; try { await fn(); baseline.value=JSON.stringify(selection.value); await load(); message.value=text; } catch(e) { error.value=e.message; } finally {busy.value=false;} }
const body = () => ({ revision:intake.value.revision, selection:selection.value });
const save = () => perform(() => api(`/dingtalk/intakes/${intake.value.id}/groups`, {method:'PUT', body:body(), quiet:true}), '分组草稿已保存。');
const confirm = () => perform(() => api(`/dingtalk/intakes/${intake.value.id}/confirm`, {method:'POST', body:body(), quiet:true}), '分组已确认，各组正在独立进行后台预分析。点击合同组继续确认审查信息。');
async function analyze() { await perform(() => api(`/dingtalk/intakes/${intake.value.id}/analyze`,{method:'POST',body:{revision:intake.value.revision},quiet:true}), '已提交后台解析。原分组草稿保留，新的建议不会覆盖已保存的人工选择。'); }
async function retry() { await perform(() => api(`/dingtalk/intakes/${intake.value.id}/retry`,{method:'POST',body:{revision:intake.value.revision},quiet:true}), '正在重新收取审批附件，可离开此页。'); }
async function replaceFile(doc,event) {const file=event.target.files[0];if(!file)return;try{await perform(()=>{const data=new FormData();data.set('file',file);data.set('revision',intake.value.revision);return api(`/dingtalk/intakes/${intake.value.id}/documents/${doc.id}/file`,{method:'POST',body:data,quiet:true});},'文件已保存为该附件的新版本，受影响合同组将重新审查。');}finally{event.target.value='';}}
async function addFile(event){const file=event.target.files[0];if(!file)return;try{await perform(()=>{const data=new FormData();data.set('file',file);data.set('revision',intake.value.revision);return api(`/dingtalk/intakes/${intake.value.id}/documents`,{method:'POST',body:data,quiet:true});},'新增材料已保存，请确认它所属的合同组。');}finally{event.target.value='';}}
function useSuggestion() { if(!intake.value.analysis)return;selection.value=JSON.parse(JSON.stringify({groups:intake.value.analysis.groups,excluded:intake.value.analysis.excluded||[]})); }
function canLeave(){return !busy.value && (!dirty.value || window.confirm('分组草稿尚未保存，确定离开？'));}
function beforeUnload(e){if(dirty.value||busy.value){e.preventDefault();e.returnValue='';}}
onBeforeRouteLeave(canLeave);
onMounted(async()=>{await load();timer=setInterval(()=>load(true),5000);window.addEventListener('beforeunload',beforeUnload);});
onUnmounted(()=>{clearInterval(timer);window.removeEventListener('beforeunload',beforeUnload);});
</script>
<template>
  <div v-if="!intake" class="empty-state">{{ error || '正在读取审批附件…' }}</div>
  <section v-else-if="intake.autoReviewBatchId" class="panel group-panel"><h1>{{ intake.title }}</h1><p>全部附件已进入自动评审，由 Agent 识别材料角色并生成改稿。</p><router-link :to="'/auto-review/'+intake.autoReviewBatchId">进入自动评审批次 →</router-link></section>
  <template v-else>
    <section class="detail-heading"><div><router-link to="/" class="back-link">← 返回合同台账</router-link><h1>{{ intake.title }}</h1><p>{{ names[intake.status] }} · {{ time(intake.created_at) }}</p></div><div class="action-row"><button :disabled="busy||dirty" @click="load()">刷新</button><button v-if="role('legal')" :disabled="busy||dirty" @click="retry">重试收取附件</button><button v-if="role('legal')" :disabled="busy||dirty" @click="analyze">重新解析与建议</button></div></section>
    <p v-if="error" class="notice danger" role="alert">{{ error }}<span v-if="dirty"> 当前选择已保留；如提示记录已更新，请先复制需要保留的调整，再刷新。</span></p><p v-if="intake.error" class="notice danger">{{ intake.error }}</p><p v-if="message" class="notice success" role="status">{{ message }}</p>
    <p class="notice">同一审批可包含多组独立合同。每组选择一份主合同，并明确补充协议、价格及履约附件、参考材料；也可说明原因后排除文件。确认后各组独立审查，支持离开页面等待。</p>
    <section class="panel"><div class="panel-heading"><h2>审批全部附件 · {{ intake.documents.length }} 份</h2><span>未归组 {{ unassigned.length }} 份</span><label v-if="role('legal')" class="button-file">＋ 添加关联材料<input type="file" :accept="uploadAccept" :disabled="busy||dirty" @change="addFile" /></label></div><div class="table-scroll"><table><thead><tr><th>文件 / 格式</th><th>收取及解析状态</th><th>归属与处理</th></tr></thead><tbody><tr v-for="d in intake.documents" :key="d.id"><td><b>{{ d.filename }}</b><small>{{ d.filename.split('.').pop().toUpperCase() }}<span v-if="d.version"> · v{{ d.version.version_no }}</span></small><a v-if="d.version" :href="`/api/files/${d.version.id}?download=1`">下载原件</a></td><td>{{ !d.present?'审批中已缺失':d.status==='collected'?(d.version?.parsed?.blocks?.length?'已读取正文':'等待解析'):d.status==='unsupported'?'格式不支持':d.status==='failed'?'收取失败':'待收取' }}<small class="error-text">{{ d.error || intake.analysis?.profiles?.find(p=>p.documentId===d.id)?.error }}</small><small v-for="w in d.version?.parsed?.warnings || []" :key="w">{{ w }}</small></td><td><span>{{ used(d.id)?'已选入合同组':excluded(d.id)?'已说明排除':'待确认归属' }}</span><label v-if="role('legal')" class="button-file">补传 / 上传修改稿<input type="file" :accept="uploadAccept" :disabled="busy||dirty" @change="replaceFile(d,$event)" /></label><label v-if="!used(d.id)&&role('legal')" class="inline-check"><input type="checkbox" :checked="!!excluded(d.id)" :disabled="busy" @change="toggleExclude(d,$event.target.checked)" />排除</label><textarea v-if="excluded(d.id)" v-model="excluded(d.id).reason" :disabled="busy||!role('legal')" placeholder="填写排除原因，如与本次交易无关" maxlength="2000" /></td></tr></tbody></table></div></section>
    <section class="panel group-panel"><div class="panel-heading"><h2>确认主合同及关联材料</h2><div class="action-row"><button v-if="role('legal')&&intake.analysis" :disabled="busy" @click="useSuggestion">使用 AI 建议</button><button v-if="role('legal')" :disabled="busy" @click="addGroup">＋ 新增合同组</button></div></div><p v-if="intake.analysis?.notes" class="muted">{{ intake.analysis.notes }}</p><fieldset :disabled="busy||!role('legal')"><article v-for="(g,i) in selection.groups" :key="i" class="contract-group"><div class="action-row"><label>合同组名称<input v-model="g.name" maxlength="300" /></label><button @click="selection.groups.splice(i,1)">移除本组</button></div><label>主合同<select v-model="g.mainDocumentId" @change="g.materials=g.materials.filter(m=>m.documentId!==g.mainDocumentId);selection.excluded=selection.excluded.filter(e=>!used(e.documentId))"><option value="">请选择一份主合同</option><option v-for="d in intake.documents" :key="d.id" :value="d.id">{{ d.filename }} · {{ d.id.slice(0,6) }}</option></select></label><div v-for="d in intake.documents.filter(d=>d.id!==g.mainDocumentId)" :key="d.id" class="material-row"><span>{{ d.filename }}</span><select :value="g.materials.find(m=>m.documentId===d.id)?.role||''" :aria-label="g.name+'中'+d.filename+'的角色'" @change="setMaterial(g,d.id,$event.target.value)"><option value="">不选入本组</option><option v-for="(name,key) in roles" :key="key" :value="key">{{ name }}</option></select></div></article></fieldset><p v-if="!selection.groups.length" class="empty-state compact">等待 AI 建议，或新增合同组进行人工选择。</p><div v-if="role('legal')" class="dialog-actions"><span>{{ dirty?'有未保存调整':'草稿已同步' }}</span><button :disabled="busy" @click="save">保存分组草稿</button><button class="primary" :disabled="busy||!selection.groups.length||!!unassigned.length" @click="confirm">确认分组并后台预分析</button></div></section>
    <section v-if="intake.groups.length" class="panel group-panel"><div class="panel-heading"><h2>合同组与独立审查</h2></div><p v-if="intake.status!=='confirmed'" class="notice">审批附件有变化或正在重新分析。请确认最新归属后继续审查；历史意见和结论仍保留。</p><div class="group-links"><router-link v-for="g in intake.groups" :key="g.id" :to="'/contracts/'+g.contractId"><b>{{ g.name }}</b><span>确认审查信息 / 查看联合审查 →</span></router-link></div></section>
  </template>
</template>
<style scoped>
.group-panel{margin-top:22px;padding:22px}.group-panel>.panel-heading{padding:0 0 16px}fieldset{border:0;padding:0;margin:0;min-width:0}.contract-group{border:1px solid #dfe5ec;border-radius:10px;padding:20px;margin:14px 0}.contract-group label{display:flex;gap:10px;align-items:center;margin:10px 0}.material-row{display:flex;align-items:center;justify-content:space-between;gap:16px;border-top:1px solid #edf0f4;padding:10px 0}.material-row select{max-width:220px}.group-links{display:grid;gap:14px}.group-links a{display:flex;justify-content:space-between;gap:12px;padding:16px;background:#f6f8fc;border-radius:8px}small{display:block;overflow-wrap:anywhere}textarea{display:block;max-width:100%}.button-file{display:inline-flex;margin:8px}.contract-group input{max-width:100%}@media(max-width:700px){.material-row,.group-links a,.contract-group label{align-items:stretch;flex-direction:column}.material-row select{max-width:100%}.group-panel{padding:14px}}
</style>
