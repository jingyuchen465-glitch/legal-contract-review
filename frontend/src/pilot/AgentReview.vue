<script setup>
import { ref, computed, onMounted, onUnmounted, watch, defineAsyncComponent } from 'vue';
import { useRoute, onBeforeRouteLeave } from 'vue-router';
import { io } from 'socket.io-client';
import { ElMessage } from 'element-plus/es/components/message/index.mjs';
import { api, role, label, time } from './api';
import DocumentView from './DocumentView.vue';
import RevisionReview from './RevisionReview.vue';
import OfficeWorkspace from './OfficeWorkspace.vue';
const WordReviewWorkspace = defineAsyncComponent(() => import('./WordReviewWorkspace.vue'));
import PdfWordConversion from './PdfWordConversion.vue';
import AgentChat from './AgentChat.vue';
import { uploadAccept, uploadProblem } from './upload-formats';
import { fileFindings } from './joint-documents.mjs';
import { completedReports, selectReport, reportIncludesVersion } from './review-reports.mjs';
import './agent-review.css';
const route = useRoute(), contract = ref(), session = ref(), run = ref(), selectedVersion = ref(typeof route.query.version === 'string' ? route.query.version : ''), selectedReview = ref(''), selectedFinding = ref('');
const locationRequest = ref(null);
const loading = ref(true), error = ref(''), busy = ref(false), message = ref(''), events = ref([]), tab = ref('opinions'), followLatest = ref(true), editor = ref(false), office = ref(), annotatedArtifact = ref(null);
const decisionDialog = ref(false), decision = ref({ outcome: 'agree', reason: '', conditions: '' });
const dispositionDialog = ref(false), disposition = ref({ action: 'accept', reason: '', suggestion: '' }), dispositionTarget = ref();
const versionRows = ref([]), uploadKind = ref('supplement'), showUpload = ref(false), feedback = ref(false);
const editorSource = ref(null), editorVersion = ref(''), editorReviewId = ref(''), selections = new Map(), documentVersions = new Map();
const legacyEditor = ref(false);
let timer, socket, cursor = 0, activeSession = '', requestSequence = 0, disposed = false;
const fileCurrentId = computed(() => version.value?.contract_id && version.value.contract_id !== contract.value?.id
  ? contract.value?.jointDocuments?.find(d => d.version?.contract_id === version.value.contract_id)?.version?.id
  : contract.value?.current_version_id);
const atLatest = computed(() => !!selectedVersion.value && selectedVersion.value === fileCurrentId.value);
const mainCurrent = computed(() => atLatest.value && selectedVersion.value === contract.value?.current_version_id);
const current = computed(() => run.value?.id === contract.value?.current_review_id && run.value?.version_id === contract.value?.current_version_id);
const working = computed(() => ['queued', 'running'].includes(session.value?.status));
const liveRun = computed(() => session.value?.reviews?.find(r => r.id === session.value.current_review_id));
const reports = computed(() => {
  const rows = new Map((contract.value?.reviews || []).map(r => [r.id, r]));
  for (const r of session.value?.reviews || []) rows.set(r.id, { ...rows.get(r.id), ...r });
  return completedReports([...rows.values()], selectedVersion.value);
});
const retainingReport = computed(() => !!run.value && !!liveRun.value && run.value.id !== liveRun.value.id && !liveRun.value.agent_result);
const editable = computed(() => role('legal') && mainCurrent.value && current.value && run.value?.status === 'completed' && !run.value?.decision);
const version = computed(() => versionRows.value.find(v => v.id === selectedVersion.value));
const previous = computed(() => versionRows.value.find(v => v.id === version.value?.parent_id));
const annotations = computed(() => run.value?.snapshot?.jointGroup ? fileFindings(run.value.findings || [], selectedVersion.value, run.value.version_id) : (run.value?.findings || []).filter(f => !f.evidence.length || f.evidence.some(e => !e.versionId || e.versionId === selectedVersion.value)));
const chosen = computed(() => run.value?.findings?.find(f => f.id === selectedFinding.value));
const displayedFindings = computed(() => run.value?.snapshot?.jointGroup ? fileFindings(run.value.findings || [], selectedVersion.value, run.value.version_id) : run.value?.findings || []);
const annotationAllowed = computed(() => mainCurrent.value && run.value?.status === 'completed' && !!run.value.agent_result && run.value.version_id === contract.value?.current_version_id && (!editor.value || editorVersion.value === contract.value.current_version_id));
const annotationReason = computed(() => !atLatest.value ? '历史版本只读，可下载历史批注' : !mainCurrent.value ? '请切回主合同生成建议稿' : !annotationAllowed.value ? `等待 v${version.value?.version_no || ''} 审查完成后生成建议稿` : '');
const pendingQuestion = computed(() => session.value?.messages.find(m => m.review_id === session.value.current_review_id && m.kind === 'question'));
const questionActive = computed(() => session.value?.status === 'waiting_input' && !!pendingQuestion.value);
const stageNames = { reading_materials: '读取合同与附件', recovering: '恢复审查', awaiting_answer: '等待补充信息', paused: '审查已暂停', awaiting_human_review: '等待法务判断', artifact_generated: '批注建议稿已生成', queued: '等待开始', failed: '需要处理' };
const toolNames = { list_documents: '查看材料目录', read_document: '阅读合同原文', search_documents: '核查关联条款', search_internal_laws: '检索内部法律资料', read_internal_law: '读取法律正文', search_official_sources: '检索官方来源', read_official_source: '核对官方正文', search_memories: '检索法务经验', skill: '加载审查技能', read_skill_resource: '读取技能方法', update_task_notes: '保存审查进展', request_information: '请求补充信息', submit_review: '提交审查意见', generate_annotated_docx: '生成 Word 批注建议稿', 'dsh-tool': '执行 dsh 工具' };
toolNames.read_revision_baseline = '核对上轮问题与法务处理';
async function refresh(quiet = false) {
  const id = route.params.id, sequence = ++requestSequence;
  const requestedVersion = selectedVersion.value, requestedReview = selectedReview.value, follow = followLatest.value;
  const valid = () => !disposed && id === route.params.id && sequence === requestSequence;
  try {
    const c = await api('/contracts/' + id, { quiet }); if (!valid()) return false;
    const versions = new Map([...documentVersions, ...c.versions.map(v => [v.id, v]), ...(c.jointDocuments || []).filter(d => d.version).map(d => [d.version.id, d.version])]);
    const target = versions.has(requestedVersion) ? requestedVersion : c.current_version_id;
    const sessions = await api(`/contracts/${id}/agent-sessions`, { quiet });
    const preferred = completedReports(c.reviews, target).find(r => r.id === requestedReview) || completedReports(c.reviews, target)[0];
    const s = sessions.find(s => s.version_id === target) || sessions.find(s => s.id === preferred?.agent_session_id);
    let nextSession = null, feed = { cursor: 0, events: [] };
    if (s) {
      nextSession = await api('/agent-sessions/' + s.id, { quiet });
      feed = await api(`/agent-sessions/${s.id}/events?after=${activeSession === s.id ? cursor : 0}`, { quiet });
    }
    const rows = new Map((c.reviews || []).map(r => [r.id, r]));
    for (const r of nextSession?.reviews || []) rows.set(r.id, { ...rows.get(r.id), ...r });
    const reviewId = selectReport(completedReports([...rows.values()], target), requestedReview, follow);
    const nextRun = reviewId ? await api('/reviews/' + reviewId, { quiet }) : null;
    if (!valid()) return false;
    for (const d of nextRun?.documents || []) if (d.version) { versions.set(d.versionId, d.version); documentVersions.set(d.versionId, d.version); }
    contract.value = c; versionRows.value = [...versions.values()]; selectedVersion.value = target;
    session.value = nextSession; selectedReview.value = reviewId; run.value = nextRun;
    events.value = [...(activeSession === s?.id ? events.value : []), ...feed.events].slice(-100);
    activeSession = s?.id || ''; cursor = feed.cursor;
    error.value = '';
    return true;
  } catch (e) { if (valid() && !quiet) error.value = e.message; return false; }
  finally { if (valid()) loading.value = false; }
}
async function operation(work) { if (busy.value) return; busy.value = true; error.value = ''; try { await work(); await refresh(); } catch (e) { error.value = e.message; } finally { busy.value = false; } }
async function start() { if (!mainCurrent.value) return; await operation(async () => { await api(`/contracts/${contract.value.id}/agent-sessions`, { method: 'POST', body: { revision: contract.value.revision, clientKey: crypto.randomUUID() } }); followLatest.value = true; selectedVersion.value = contract.value.current_version_id; }); }
async function send(answer) {
  if (!mainCurrent.value || (!answer?.answers && !message.value.trim()) || !session.value || working.value || busy.value) return;
  if (answer?.answers && (!questionActive.value || answer.questionId !== pendingQuestion.value.id)) return;
  const content = answer?.answers ? answer.content || '' : message.value;
  await operation(async () => {
    const endpoint = questionActive.value ? 'answers' : 'messages';
    await api(`/agent-sessions/${session.value.id}/${endpoint}`, { method: 'POST', body: { content, clientKey: crypto.randomUUID(), ...(questionActive.value ? { questionId: pendingQuestion.value.id } : {}), ...(answer?.answers ? { answers: answer.answers } : {}), learn: answer?.answers ? false : feedback.value } });
    message.value = ''; feedback.value = false; tab.value = 'conversation';
  });
}
async function cancel() { if (mainCurrent.value) await operation(() => api(`/agent-sessions/${session.value.id}/cancel`, { method: 'POST', body: {} })); }
async function resume() { if (mainCurrent.value) await operation(async () => { await api(`/agent-sessions/${session.value.id}/resume`, { method: 'POST', body: { clientKey: crypto.randomUUID() } }); }); }
async function chooseReview() { followLatest.value = false; selections.set(selectedVersion.value, { id: selectedReview.value, follow: false }); await refresh(); }
async function generateAnnotatedVersion() {
  if (busy.value) return;
  busy.value = true; error.value = '';
  try {
    const source = contract.value.current_version_id;
    if (editor.value) {
      const saved = await office.value?.saveForNavigation();
      if (!saved || saved === false) return;
      if (saved.versionId && saved.versionId !== source) {
        await editorSaved(saved);
        ElMessage.info(`已保存为 v${saved.versionNo}，重新审查完成后可生成建议稿`);
        return;
      }
    }
    if (!await refresh(true)) throw new Error('无法核验当前版本，请稍后重试；编辑内容已保留');
    if (!annotationAllowed.value) { ElMessage.info(annotationReason.value); return; }
    annotatedArtifact.value = await api(`/reviews/${run.value.id}/annotated-version`, { method: 'POST', body: { mode: 'comments' }, quiet: true });
    editor.value = false;
    selectedVersion.value = '';
    selectedReview.value = ''; followLatest.value = true;
    if (!await refresh(true)) error.value = '生成成功，页面刷新失败，请重试刷新；可通过下方链接下载建议稿';
    ElMessage.success(`批注建议稿已保存为 v${annotatedArtifact.value.versionNo}，原文件已保留并将重新预审。`);
  } catch (e) { error.value = e.message; }
  finally { busy.value = false; }
}
async function selectFile(target) {
  if (busy.value) return false;
  if (editor.value) { const saved = await office.value?.saveForNavigation(); if (!saved) return false; editor.value = false; }
  selections.set(selectedVersion.value, { id: selectedReview.value, follow: followLatest.value });
  const retained = reportIncludesVersion(run.value, target) ? run.value.id : '';
  selectedVersion.value = target; selectedFinding.value = ''; message.value = ''; feedback.value = false;
  selectedReview.value = selections.get(target)?.id || retained;
  followLatest.value = selections.get(target)?.follow ?? !retained;
  run.value = null; session.value = null; activeSession = ''; cursor = 0; events.value = [];
  return await refresh();
}
async function locate(e, id) {
  if (e?.versionId && e.versionId !== selectedVersion.value && !await selectFile(e.versionId)) return;
  selectedFinding.value = id;
  // A new request also handles clicking an already-selected finding.
  locationRequest.value = { findingId: id, evidence: e };
}
function locateEntry() {
  const block = version.value?.parsed?.blocks.find(b => b.id === route.query.block);
  if (block) locationRequest.value = { findingId: 'auto-batch-anchor', evidence: { versionId: version.value.id, blockId: block.id, quote: block.text } };
}
function locateFinding(finding) {
  const evidence = finding.evidence || [];
  return locate(evidence.find(e => !e.versionId || e.versionId === selectedVersion.value) || evidence[0], finding.id);
}
async function switchFile(e) { const target = e.target.value; e.target.value = selectedVersion.value; await selectFile(target); }
async function openEditor() {
  if (busy.value) return;
  busy.value = true;
  try {
    if (!atLatest.value) { selectedVersion.value = fileCurrentId.value || contract.value.current_version_id; selectedReview.value = ''; followLatest.value = true; }
    if (!await refresh()) return;
    legacyEditor.value = false;
    editorSource.value = version.value; editorVersion.value = version.value.id; editorReviewId.value = run.value?.id || ''; editor.value = true;
  } finally { busy.value = false; }
}
async function editorSaved(value) {
  if (!value?.versionId) return;
  editorVersion.value = value.versionId; selectedVersion.value = value.versionId; selectedReview.value = ''; followLatest.value = true;
  // The saved version may not be in the old material list until this refresh.
  documentVersions.set(value.versionId, { ...editorSource.value, id: value.versionId, version_no: value.versionNo });
  await refresh(true);
}
function openLegacyEditor() {
  editorSource.value = { ...editorSource.value, id: editorVersion.value, version_no: version.value?.version_no || editorSource.value.version_no };
  legacyEditor.value = true;
}
function openDisposition(id, action) { const f = run.value.findings.find(f => f.id === id); if (!f) return; dispositionTarget.value = f; disposition.value = { action, reason: '', suggestion: f.disposition?.suggestion || f.suggestion }; dispositionDialog.value = true; }
async function saveDisposition() { await operation(async () => { const f = dispositionTarget.value; const input = { ...disposition.value, revision: f.revision }; if (input.action !== 'correct') delete input.suggestion; await api(`/reviews/${run.value.id}/findings/${f.id}/disposition`, { method: 'PUT', body: input }); dispositionDialog.value = false; }); }
async function finalize() { await operation(async () => { await api(`/reviews/${run.value.id}/decision`, { method: 'POST', body: { ...decision.value, revision: contract.value.revision } }); decisionDialog.value = false; }); }
async function upload(e) { const file = e.target.files?.[0]; if (!file) return; const problem = uploadProblem([file]); if (problem) { error.value = problem; return; } await operation(async () => { const data = new FormData(); data.set('file', file); data.set('revision', contract.value.revision); data.set('kind', uploadKind.value); await api(`/contracts/${contract.value.id}/versions`, { method: 'POST', body: data }); followLatest.value = true; selectedVersion.value = ''; showUpload.value = false; }); e.target.value = ''; }
async function closeEditor(value) { if (value?.versionId) await editorSaved(value); editor.value = false; await refresh(); }
onBeforeRouteLeave(async () => !editor.value || await office.value?.saveForNavigation() !== false);
watch(() => questionActive.value ? pendingQuestion.value?.id : null, id => { if (id) tab.value = 'conversation'; });
watch(() => route.params.id, async () => { editor.value = false; selections.clear(); documentVersions.clear(); contract.value = null; session.value = null; run.value = null; selectedVersion.value = typeof route.query.version === 'string' ? route.query.version : ''; selectedReview.value = ''; annotatedArtifact.value = null; activeSession = ''; cursor = 0; events.value = []; followLatest.value = true; socket?.emit('join-contract', route.params.id); await refresh(); locateEntry(); });
onMounted(async () => { await refresh(); locateEntry(); timer = setInterval(() => { if (!busy.value) refresh(true); }, 3000); socket = io({ withCredentials: true }); socket.emit('join-contract', route.params.id); socket.on('review-progress', () => { if (!busy.value) refresh(true); }); });
onUnmounted(() => { disposed = true; requestSequence++; clearInterval(timer); socket?.disconnect(); });
</script>
<template>
  <div v-if="loading" class="panel">正在打开合同审查…</div>
  <div v-else-if="contract" class="agent-workspace">
    <section class="page-heading agent-heading"><div><router-link to="/" class="back-link">← 合同与待办</router-link><h1>{{ contract.title }}</h1><p>{{ contract.number }} · {{ label(contract.legal_status) }}</p></div><div class="action-row"><router-link :to="contract.autoReviewBatchId ? `/auto-review/${contract.autoReviewBatchId}` : '/auto-review'">进入自动评审{{ contract.autoReviewBatchId ? '批次' : '' }} →</router-link><button v-if="mainCurrent" @click="showUpload=true" :disabled="busy">补充材料 / 新稿</button><button v-if="mainCurrent" @click="start" :disabled="busy || working">{{ session?'重新审查':'开始审查' }}</button><button v-if="mainCurrent && working" @click="cancel" :disabled="busy">停止</button><button v-if="mainCurrent && session && ['failed','cancelled','waiting_input'].includes(session.status) && !questionActive" @click="resume" :disabled="busy">继续审查</button><button v-if="editable && !editor" class="primary" @click="decisionDialog=true">确认法务结论</button></div></section>
    <p v-if="error" class="notice danger" role="alert">{{ error }}</p><p v-if="!atLatest" class="notice">历史版本只读，原报告与批注保留供核对。改稿请切换到最新版。</p>
    <p v-if="contract.jointIntake && contract.jointIntake.status!=='confirmed'" class="notice"><router-link :to="'/dingtalk/intakes/'+contract.jointIntake.id">审批附件分组需要核实，请先确认哪些材料属于同一交易。</router-link></p>
    <p v-if="annotatedArtifact" class="notice">批注建议稿已保存为 v{{ annotatedArtifact.versionNo }}，原文件已保留并将重新预审。<a :href="annotatedArtifact.downloadUrl">下载批注建议稿 ↗</a></p>
    <div class="agent-status-bar"><span class="agent-live-dot" :class="{active:working}"></span><b>{{ working?'Agent 正在处理':retainingReport && liveRun?.error_code==='AGENT_INCOMPLETE'?'等待继续沟通':label(session?.status)||'尚未开始审查' }}</b><span>{{ current && run?.decision && !run.decision.withdrawal ? '法务结论已确认' : stageNames[liveRun?.stage] || '' }}</span><span v-if="liveRun?.coverage?.totalBlocks">已读取 {{ liveRun.coverage.readBlocks }} / {{ liveRun.coverage.totalBlocks }} 段</span><small>读取覆盖不代表风险全部识别</small></div>
    <p v-if="liveRun?.error_message && !(retainingReport && liveRun.error_code==='AGENT_INCOMPLETE')" class="notice" role="alert">{{ liveRun.error_message }}</p><p v-if="run?.coverage?.requiresRecheck" class="notice danger">引用的经验来源已撤销，本结果需重新审查。</p>
    <div class="agent-layout" v-if="!editor">
      <section class="agent-document"><div class="agent-panel-header"><select :disabled="busy" :value="selectedVersion" @change="switchFile" aria-label="当前材料"><option v-for="v in versionRows" :key="v.id" :value="v.id">v{{ v.version_no }} · {{ v.filename }}</option></select><button v-if="role('legal') && version" :disabled="busy" @click="openEditor">{{ atLatest ? '页边批注与修订' : '切换到最新版审阅' }}</button></div><PdfWordConversion v-if="mainCurrent && version?.filename?.toLowerCase().endsWith('.pdf')" :version="version" :contract="contract" @created="closeEditor" /><DocumentView v-if="version" :key="version.id" :version="version" :previous="previous" :location-request="locationRequest" :findings="annotations" :evidence="chosen?.evidence" :selected-finding-id="selectedFinding" :editable="editable" @select-finding="selectedFinding=$event" @adopt-finding="openDisposition($event,'accept')" @reject-finding="openDisposition($event,'reject')" @correct-finding="openDisposition($event,'correct')" /></section>
      <section class="agent-assistant"><div class="agent-panel-header agent-tabs"><button v-for="t in [{id:'opinions',name:'审查意见'},{id:'conversation',name:'继续沟通'},{id:'activity',name:'执行进展'}]" :key="t.id" :class="{selected:tab===t.id}" @click="tab=t.id">{{ t.name }}</button></div>
        <div class="agent-results" v-show="tab==='opinions'"><div class="agent-result-version" v-if="reports.length"><label>审查报告<select v-model="selectedReview" @change="chooseReview" aria-label="审查报告"><option v-for="r in reports" :value="r.id" :key="r.id">{{ time(r.created_at) }} · 已完成</option></select></label><button class="text-btn" @click="followLatest=true;refresh()">最新报告</button></div>
          <p v-if="retainingReport" class="notice agent-report-notice">{{ working?'正在处理本次沟通，继续展示已完成的审查报告。':'本次沟通尚未形成新报告，继续展示已完成的审查报告。' }}<button class="text-btn" @click="tab='conversation'">查看沟通</button></p>
          <p v-if="run && !current && !run.decision" class="muted">本报告供查阅和导出。确认法务结论前，需完成当前审查任务。</p>
          <article v-if="run?.agent_result" class="agent-summary"><h2>审查概览</h2><p>{{ run.agent_result.summary }}</p><ul v-if="run.agent_result.limitations?.length" class="agent-limitations"><li v-for="item in run.agent_result.limitations" :key="item">{{ item }}</li></ul></article>
          <RevisionReview :report="run?.agent_result" :baseline="run?.snapshot?.revisionBaseline" @locate="locate($event,'revision-'+$event.blockId)" />
          <div v-if="run?.decision" class="notice"><b>法务结论：{{ label(run.decision.outcome) }}</b><p>{{ run.decision.reason }} {{ run.decision.conditions }}</p><small>绑定本文件与本结果版本 · {{ time(run.decision.created_at) }}</small></div>
          <p v-if="editable && displayedFindings.length" class="muted">认可或修正意见仅保存复核记录，不会修改合同正文；修改正文请打开改稿。</p>
          <article v-for="f in displayedFindings" :key="f.id" class="agent-finding" :class="{selected:selectedFinding===f.id}" @click="locateFinding(f)"><div class="agent-finding-title"><span class="badge" :class="f.severity">{{ label(f.severity) }}</span><h3><button type="button" class="agent-finding-link" @click.stop="locateFinding(f)">{{ f.title }}</button></h3><span v-if="f.disposition" class="badge completed">{{ label(f.disposition.action) }}</span></div><p>{{ f.reason }}</p><blockquote v-for="e in f.evidence" :key="e.versionId+e.blockId+e.quote" role="button" tabindex="0" @click.stop="locate(e,f.id)" @keydown.enter.stop.prevent="locate(e,f.id)" @keydown.space.stop.prevent="locate(e,f.id)">{{ e.quote }}<small>定位原文 ↗</small></blockquote><div v-if="f.suggestion" class="agent-suggestion"><b>建议条款</b><p>{{ f.disposition?.suggestion || f.suggestion }}</p></div><details v-if="f.legal_refs.length" @click.stop><summary>法律依据与来源</summary><p v-for="s in f.legal_refs" :key="s.id"><a v-if="s.source?.startsWith('https://')" :href="s.source" target="_blank" rel="noopener noreferrer">{{ s.title }}</a><span v-else>{{ s.title }}</span><small>现行效力需结合本案核实</small></p></details><div v-if="editable" class="action-row"><button @click.stop="openDisposition(f.id,'accept')">认可意见</button><button @click.stop="openDisposition(f.id,'reject')">驳回</button><button @click.stop="openDisposition(f.id,'correct')">修正意见</button><button v-if="f.suggestion" @click.stop="openEditor">打开改稿</button></div></article>
          <div v-if="!run" class="agent-empty"><h2>{{ working?'当前版本正在审查':session?'当前文件尚无完整审查报告':'审查从合同开始' }}</h2><p>{{ questionActive?'请在沟通区补充必要信息，Agent 将继续审查。':'完整审查报告生成后会显示在这里，普通沟通不会新增报告版本。' }}</p><button v-if="questionActive" @click="tab='conversation'">补充信息</button></div>
          <div class="action-row" v-if="run?.status==='completed' && run.agent_result"><button v-if="role('business','legal')" class="primary" :disabled="busy || !annotationAllowed" :title="annotationReason" @click="generateAnnotatedVersion">生成批注建议稿</button><a :href="'/api/reviews/'+run.id+'/annotated-contract?versionId='+selectedVersion">下载所选文件历史批注 ↗</a><small v-if="annotationReason">{{ annotationReason }}</small><a :href="'/api/reviews/'+run.id+'/report?format=html'" target="_blank" rel="noopener noreferrer">导出所选报告 ↗</a><a v-if="annotatedArtifact" :href="annotatedArtifact.downloadUrl">下载 v{{ annotatedArtifact.versionNo }} 批注建议稿 ↗</a></div>
        </div>
        <div v-show="tab==='activity'" class="agent-activity"><article v-for="e in [...events].reverse()" :key="e.id"><span class="agent-activity-dot"></span><div><b>{{ toolNames[e.data.name] || ({queued:'任务已建立',started:'开始审查',model_request:'分析与规划',tools_ready:'审查工具已就绪',skill_loaded:'加载审查技能',dsh_tool_event:'执行 dsh 工具',completed:'审查完成',waiting_input:'等待补充',failed:'审查中断',cancelled:'已停止',paused:'已暂停'})[e.type] || '保存进展' }}</b><p>{{ e.data.message }}</p><small>{{ time(e.created_at) }}<template v-if="e.data.number"> · 模型请求 {{ e.data.number }}/{{ e.data.maxRequests }}</template><template v-if="e.type==='dsh_tool_event' && e.data.phase"> · {{ e.data.phase }}</template></small><details v-if="e.type==='dsh_tool_event' && e.data.detail"><summary>查看工具输入/输出</summary><pre>{{ JSON.stringify(e.data.detail, null, 2) }}</pre></details></div></article></div>
        <AgentChat :readonly="!mainCurrent" :key="session?.id || 'no-session'" v-model="message" v-model:feedback="feedback" :messages="session?.messages || []" :visible="tab==='conversation'" :has-session="!!session" :working="working" :busy="busy" :can-learn="role('legal')" :question="questionActive ? pendingQuestion.content : ''" :pending-question="questionActive ? pendingQuestion : undefined" @send="send" @answer="send" @stop="cancel" @attach="showUpload=true" />
      </section>
    </div>
    <WordReviewWorkspace v-else-if="editorSource && !legacyEditor" ref="office" :contract-id="editorSource.contract_id||contract.id" :review="run" :source-version="editorSource" :review-version-no="editorSource.version_no" @close="closeEditor" @saved="editorSaved" @legacy="openLegacyEditor" />
    <OfficeWorkspace v-else-if="editorSource" ref="office" :contract-id="editorSource.contract_id||contract.id" :review="run" :source-version="editorSource" :review-version-no="editorSource.version_no" :annotation-allowed="annotationAllowed" :annotation-reason="annotationReason" :selected-finding-id="selectedFinding" :editable="editable && run?.id === editorReviewId" :busy="busy" @close="closeEditor" @saved="editorSaved" @generate-annotations="generateAnnotatedVersion" @select-finding="selectedFinding=$event" @adopt-finding="openDisposition($event,'accept')" @reject-finding="openDisposition($event,'reject')" @correct-finding="openDisposition($event,'correct')" />
    <details class="agent-history"><summary>合同处理记录 · {{ contract.reviews.length }} 条</summary><router-link v-for="r in contract.reviews" :key="r.id" :to="'/contracts/'+contract.id+'/history/'+r.id">{{ time(r.created_at) }} · {{ r.engine==='harness-v1'?(r.agent_result?'审查报告':'沟通与执行记录'):'历史审查' }} · {{ label(r.status) }}</router-link></details>
    <el-dialog v-model="decisionDialog" title="确认本版法务结论" width="min(560px,90vw)"><form @submit.prevent="finalize" class="stack"><p>结论绑定当前文件和本版审查结果。后续追问会另存结果。</p><label>结论<select v-model="decision.outcome"><option value="agree">同意</option><option value="conditional">附条件同意</option><option value="disagree">不同意</option></select></label><label>理由<textarea v-model="decision.reason" rows="3" :required="decision.outcome==='disagree'" /></label><label v-if="decision.outcome==='conditional'">需落实的条件<textarea v-model="decision.conditions" required rows="3" /></label><button class="primary" :disabled="busy">确认结论</button></form></el-dialog>
    <el-dialog v-model="dispositionDialog" :title="({accept:'认可审查意见',reject:'驳回审查意见',correct:'修正审查意见'})[disposition.action] || '处理审查意见'" width="min(560px,90vw)"><form @submit.prevent="saveDisposition" class="stack"><p>{{ dispositionTarget?.title }}</p><label>法务理由<textarea v-model="disposition.reason" rows="3" :required="disposition.action!=='accept'||dispositionTarget?.check_status==='uncertain'" /></label><label v-if="disposition.action==='correct'">修改建议<textarea v-model="disposition.suggestion" rows="6" /></label><p class="muted">此操作仅保存审查意见的复核记录，不会修改合同正文。后台会尝试从处理理由和适用条件中提炼可复用的审查技能或经验；不保证每次都生成内容。</p><button class="primary" :disabled="busy">保存复核记录</button></form></el-dialog>
    <el-dialog v-model="showUpload" title="补充材料或上传新稿" width="min(520px,90vw)"><div class="stack"><label>文件用途<select v-model="uploadKind"><option value="supplement">补充材料，加入新的审查任务</option><option value="contract">修改后的合同，保留原版本</option><option value="signed">签署件</option></select></label><input type="file" :accept="uploadAccept" @change="upload" :disabled="busy" /><small>新合同版本使用独立会话；原结果和法务结论保留。</small></div></el-dialog>
  </div>
  <div v-else class="panel"><p role="alert">{{ error||'合同暂时无法读取' }}</p><button @click="refresh()">重试</button></div>
</template>
