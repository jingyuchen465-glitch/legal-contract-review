<script setup>
import { computed, ref, shallowRef, onMounted, onBeforeUnmount } from 'vue';
import { SuperDoc } from 'superdoc';
import 'superdoc/style.css';
import { api, session as authSession } from './api';
import { readLocalReview, saveLocalReview } from './review-local-store.mjs';
import './word-review.css';
import ReviewMarginRail from './ReviewMarginRail.vue';

const props = defineProps({ contractId: String, sourceVersion: Object, review: Object, reviewVersionNo: Number, file: Object, preview: Boolean, readonly: Boolean, showLegacy: { type: Boolean, default: true } });
const emit = defineEmits(['close', 'saved', 'legacy', 'ready']);
const host = ref(), shell = ref(), input = ref(), ready = ref(false), saving = ref(false), exporting = ref(false), loading = ref(true), dirty = ref(false), error = ref(''), notice = ref(''), filename = ref(props.sourceVersion?.filename || '仓储物流服务合同.docx');
const documentVersion = ref(props.sourceVersion?.id), versionNo = ref(props.sourceVersion?.version_no || 1);
const commentCount = ref(0), resolvedCount = ref(0), commentFeedback = ref(''), changeCount = ref(0), zoom = ref(100), pageCount = ref(1), viewMode = ref('markup'), showFormatting = ref(false), activeFilter = ref('all');
const editor = shallowRef(null);
const feedbackKind = ref('comment'), decisionUndoAvailable = ref(false);
const reviewReason = ref(''), learningResult = ref(null), reviewActions = [];
const surface = ref(), rail = ref();
const localKey = 'last-opened-review';
const stops = [];
let disposed = false, loadGeneration = 0, decisionVersion;
const title = computed(() => filename.value.replace(/\.docx$/i, ''));
const status = computed(() => loading.value ? '正在打开合同…' : !ready.value && error.value ? '打开失败，请重试' : saving.value ? '正在保存…' : dirty.value || reviewReason.value.trim() ? '有修改待保存' : notice.value || (props.readonly ? `v${versionNo.value} · 只读审阅` : props.preview ? '本地示例 · 修改可保存到本机' : `v${versionNo.value} · 已保存`));
const user = computed(() => ({ name: authSession.user?.displayName || '法务审阅人', email: `${authSession.user?.id || 'local-reviewer'}@legal.local` }));

function reportError(cause) { error.value = (typeof cause === 'string' ? cause : cause?.message) || '操作未完成，请重试；当前修改仍保留在页面中'; }
async function exportBlob() {
  if (!editor.value || !ready.value) throw new Error('合同尚未加载完成');
  const blob = await editor.value.export({ triggerDownload: false, policies: { comments: 'preserve', trackedChanges: 'review-preserving' } });
  if (!(blob instanceof Blob) || !blob.size) throw new Error('未生成有效 DOCX，请重试');
  return blob;
}
async function download() {
  if (exporting.value || saving.value || !ready.value) return false;
  exporting.value = true; error.value = '';
  try {
    const blob = await exportBlob(), url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `${title.value}_审阅修订.docx`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    notice.value = '已导出含批注与修订的 DOCX';
    return true;
  } catch (cause) { reportError(cause); return false; }
  finally { exporting.value = false; }
}
async function save(returnToReview = false) {
  if (!ready.value || saving.value || exporting.value || props.readonly) return false;
  if (!dirty.value && !reviewReason.value.trim()) { if (returnToReview) emit('close', { versionId: documentVersion.value, versionNo: versionNo.value, saved: false }); return true; }
  saving.value = true; error.value = '';
  try {
    const version = editor.value.ui.document.getVersion(), blob = await exportBlob(), actionCount = reviewActions.length, savedReason = reviewReason.value;
    let result;
    if (props.preview) {
      const nextVersion = versionNo.value + 1;
      await saveLocalReview(localKey, { blob, filename: filename.value, versionNo: nextVersion, savedAt: new Date().toISOString() });
      result = { versionId: 'local-' + nextVersion, versionNo: nextVersion, saved: true };
    } else {
      const body = new FormData(); body.append('file', blob, filename.value.replace(/\.[^.]+$/, '.docx')); body.append('baseVersionId', documentVersion.value);
      body.append('reviewReason', savedReason);
      body.append('reviewActions', JSON.stringify(reviewActions.slice(0, actionCount)));
      if (props.review?.status === 'completed' && (props.review.version_id === documentVersion.value || props.review.snapshot?.jointGroup?.documents.some(d => d.versionId === documentVersion.value))) body.append('reviewId', props.review.id);
      result = await api(`/contracts/${props.contractId}/review-document`, { method: 'POST', body, quiet: true });
    }
    documentVersion.value = result.versionId; versionNo.value = result.versionNo;
    editor.value.ui.document.markClean(version);
    dirty.value = editor.value.ui.document.getSnapshot().dirty;
    reviewActions.splice(0, actionCount);
    if (reviewReason.value === savedReason) reviewReason.value = '';
    learningResult.value = result.learning || null;
    notice.value = props.preview ? `已保存到本机 · v${result.versionNo}` : `已保存为 v${result.versionNo}`;
    emit('saved', result);
    if (returnToReview && !dirty.value) emit('close', result);
    return !dirty.value;
  } catch (cause) { reportError(cause); return false; }
  finally { saving.value = false; }
}
async function close() {
  if (saving.value || exporting.value || loading.value) return;
  if (dirty.value || reviewReason.value.trim()) { if (!await save(false)) return; }
  emit('close', { versionId: documentVersion.value, versionNo: versionNo.value, saved: false });
}
async function saveForNavigation() {
  if (saving.value || exporting.value) return false;
  if (!ready.value) return !dirty.value;
  if ((dirty.value || reviewReason.value.trim()) && !await save()) return false;
  return { versionId: documentVersion.value, versionNo: versionNo.value, saved: false };
}
function setZoom(value) { editor.value?.setZoom(Number(value)); }
async function changeDisplay(value) {
  viewMode.value = value;
  editor.value?.setViewingOptions({ trackedChanges: value });
  editor.value?.setDocumentMode(value === 'markup' && !props.readonly ? 'suggesting' : 'viewing');
}
async function command(name) {
  error.value = '';
  try {
    const result = await editor.value.ui.toolbar.executeAsync(name);
    if (result === false || result == null || result?.ok === false || result?.success === false) throw new Error(result?.reason || result?.error?.message || '当前操作不可用');
    return true;
  } catch (cause) { reportError(cause); return false; }
}
function handledComment(message) {
  feedbackKind.value = 'comment'; commentFeedback.value = message;
  decisionVersion = undefined; decisionUndoAvailable.value = false;
}
function recordOperation(value) {
  if (reviewActions.length < 300 && value.insertedText.length <= 20000 && value.deletedText.length <= 20000) reviewActions.push(value);
}
function decidedRevision(accepted) {
  feedbackKind.value = 'revision';
  commentFeedback.value = accepted ? '已接受修订，修改已合入当前正文，对应的待处理卡片已移除。请保存修改。' : '已拒绝修订，正文已恢复为该处修改前的内容，对应的待处理卡片已移除。请保存修改。';
  decisionVersion = editor.value.ui.document.getVersion(); decisionUndoAvailable.value = true;
}
async function undoDecision() {
  if (!decisionUndoAvailable.value || !Object.is(decisionVersion, editor.value.ui.document.getVersion())) return;
  if (await command('undo')) { commentFeedback.value = ''; decisionVersion = undefined; decisionUndoAvailable.value = false; }
}
function setFilter(value) { activeFilter.value = value; shell.value.dataset.filter = value; }
async function loadFile(file, preserveLocal = false) {
  const generation = ++loadGeneration;
  loading.value = true; ready.value = false; error.value = ''; dirty.value = false;
  commentFeedback.value = ''; decisionVersion = undefined; decisionUndoAvailable.value = false; setFilter('all');
  reviewActions.splice(0); reviewReason.value = ''; learningResult.value = null;
  stops.splice(0).forEach(stop => stop()); editor.value?.destroy(); editor.value = null;
  try {
    let blob = file;
    if (!blob && props.preview) {
      const saved = preserveLocal ? await readLocalReview(localKey) : null;
      if (saved) { blob = saved.blob; filename.value = saved.filename; versionNo.value = saved.versionNo; notice.value = `已恢复本机保存 · v${saved.versionNo}`; }
      else { const response = await fetch('/__review_preview/contract.docx'); if (!response.ok) throw new Error('示例合同加载失败'); blob = await response.blob(); }
    } else if (!blob) {
      const query = new URLSearchParams({ versionId: documentVersion.value });
      if (props.review?.status === 'completed' && (props.review.version_id === documentVersion.value || props.review.snapshot?.jointGroup?.documents.some(d => d.versionId === documentVersion.value))) query.set('reviewId', props.review.id);
      const response = await fetch(`/api/contracts/${props.contractId}/review-document?${query}`, { credentials: 'same-origin' });
      if (!response.ok) { const problem = await response.json(); throw new Error(problem.message || '无法打开合同'); }
      blob = await response.blob();
    }
    if (disposed || generation !== loadGeneration) return;
    host.value.replaceChildren();
    const instance = new SuperDoc({
      selector: host.value,
      document: blob,
      documentMode: props.readonly ? 'viewing' : 'suggesting',
      viewing: { trackedChanges: 'markup' },
      user: user.value,
      telemetry: { enabled: false },
      trackChanges: { enabled: true, replacementMode: 'grouped', semanticColors: { enabled: false }, authorColors: { enabled: true, overrides: { 'AI 自动合同评审': '#8b49d1', 'AI 合同预审': '#8b49d1', '法务审阅人': '#2563eb' } } },
      ui: { toolbar: false, comments: { panel: false, highlights: true }, search: true, loading: false },
      interaction: { comments: { level: props.readonly ? 'read' : 'resolve' }, trackedChanges: { allowDecisions: !props.readonly } },
      onReady: ({ superdoc }) => {
        if (disposed || generation !== loadGeneration) return;
        editor.value = superdoc; ready.value = true; loading.value = false;
        stops.push(superdoc.ui.document.observe(snapshot => {
          dirty.value = !!snapshot.dirty;
        }));
        stops.push(superdoc.ui.document.onChange(() => {
          if (decisionVersion !== undefined && !Object.is(decisionVersion, superdoc.ui.document.getVersion())) decisionUndoAvailable.value = false;
        }));
        stops.push(superdoc.ui.zoom.observe(snapshot => { zoom.value = Math.round(snapshot.value || snapshot.zoom || 100); }));
        emit('ready', superdoc);
      },
      onPaginationUpdate: payload => { pageCount.value = payload.pageCount || payload.totalPages || pageCount.value; },
      onException: payload => { if (payload.severity === 'warn') return; reportError(payload.error); if (!ready.value) loading.value = false; },
    });
    editor.value = instance;
  } catch (cause) { if (!disposed && generation === loadGeneration) { reportError(cause); loading.value = false; } }
}
async function importFile(event) {
  const file = event.target.files?.[0]; event.target.value = '';
  if (!file) return;
  if (!/\.docx$/i.test(file.name)) { error.value = '请选择 DOCX 文件'; return; }
  if (file.size > 50 * 1024 * 1024) { error.value = '文件不能超过 50MB'; return; }
  if (dirty.value && !await save()) return;
  filename.value = file.name; versionNo.value = 1; notice.value = '已打开本机文件';
  await loadFile(file);
}
function beforeUnload(event) { if (dirty.value || reviewReason.value.trim() || saving.value) { event.preventDefault(); event.returnValue = ''; } }
onMounted(() => { document.body.classList.add('margin-review-open'); window.addEventListener('beforeunload', beforeUnload); loadFile(props.file, true); });
onBeforeUnmount(() => { disposed = true; loadGeneration++; stops.splice(0).forEach(stop => stop()); editor.value?.destroy(); document.body.classList.remove('margin-review-open'); window.removeEventListener('beforeunload', beforeUnload); });
defineExpose({ save, saveForNavigation, hasPending: () => dirty.value || !!reviewReason.value.trim() || saving.value, getEditor: () => editor.value });
</script>

<template>
  <section ref="shell" class="margin-review" data-filter="all" aria-label="合同页边审阅工作区">
    <header class="margin-topbar">
      <div class="margin-file-group"><button v-if="!preview" class="margin-back" title="保存并返回" :disabled="loading || saving" @click="close">‹</button><span class="margin-file-icon"><svg viewBox="0 0 24 24" fill="none"><path d="M6 3h8l4 4v14H6zM14 3v5h5M9 12h6M9 16h6" stroke="currentColor" stroke-width="1.6"/></svg></span><div><h1>{{ title }}</h1><p><span class="margin-save-dot" :class="{dirty}"></span>{{ status }}</p></div></div>
      <div class="margin-top-actions"><span class="margin-review-tag"><i></i>{{ readonly ? '只读审阅' : '修订模式' }}</span><button v-if="preview" :disabled="loading || saving" @click="input.click()">打开本机 DOCX</button><button :disabled="!ready || exporting || saving" @click="download">{{ exporting ? '正在导出…' : '导出 DOCX' }}</button><button v-if="!readonly" class="margin-primary" :disabled="!ready || saving || exporting || (!dirty && !reviewReason.trim())" @click="save()">{{ saving ? '正在保存…' : preview ? '保存到本机' : '保存修改' }}</button><button v-if="!preview && showLegacy" class="margin-more" title="打开原 ONLYOFFICE 编辑器" :disabled="dirty || saving || !!reviewReason.trim()" @click="emit('legacy')">···</button></div>
    </header>
    <nav class="margin-toolbar" aria-label="文档审阅工具">
      <div class="margin-tools"><button :disabled="!ready || readonly" title="撤销" @click="command('undo')">↶</button><button :disabled="!ready || readonly" title="重做" @click="command('redo')">↷</button><span class="margin-tool-divider"></span><label class="margin-display"><span>显示</span><select :value="viewMode" :disabled="!ready" @change="changeDisplay($event.target.value)"><option value="markup">所有修订与批注</option><option value="final">修改后正文</option><option value="original">修改前正文</option></select></label><span class="margin-tool-divider"></span><button :disabled="!ready || readonly || viewMode !== 'markup'" @mousedown.prevent @click="rail.addComment()"><svg viewBox="0 0 20 20" fill="none"><path d="M4 3h12v10H8l-4 4zM7 7h6M7 10h4" stroke="currentColor" stroke-width="1.3"/></svg>添加批注</button><button :class="{ selected:showFormatting }" @click="showFormatting = !showFormatting">Aa<span>编辑工具</span></button></div>
      <div class="margin-tools"><label class="margin-zoom"><select :value="zoom" :disabled="!ready" @change="setZoom($event.target.value)"><option v-for="value in [60,70,80,90,100,110,125,150]" :key="value" :value="value">{{ value }}%</option></select></label><span class="margin-tool-divider"></span><span class="margin-author-key"><i></i>AI 审查批注</span><span class="margin-author-key purple"><i></i>正文修订</span></div>
    </nav>
    <details v-if="!readonly && !preview" class="margin-learning">
      <summary>沉淀本次法务经验 · 可补充修改理由</summary>
      <p>保存后，根据本次正文修改、修订处理和新增批注尝试提炼技能草稿，审核通过后复用。仅标记批注已处理不代表认可意见。</p>
      <label for="review-learning-reason">本次修改理由与适用条件（可选）</label>
      <textarea id="review-learning-reason" v-model="reviewReason" :disabled="saving" maxlength="3000" rows="2" placeholder="例如：本次改为验收后付款，因为交付并不代表质量合格；仅适用于需要验收的采购。具体意见也可以在对应批注中回复。"></textarea>
    </details>
    <div v-if="learningResult" class="margin-learning-result" role="status"><span>{{ learningResult.message }}</span><router-link v-if="learningResult.sourceId" :to="`/experience?source=${learningResult.sourceId}`">查看整理记录 →</router-link></div>
    <div v-if="showFormatting" class="margin-formatting"><button :disabled="!ready || readonly" @mousedown.prevent @click="command('bold')"><b>B</b></button><button :disabled="!ready || readonly" @mousedown.prevent @click="command('italic')"><i>I</i></button><button :disabled="!ready || readonly" @mousedown.prevent @click="command('underline')"><u>U</u></button><span>选中文字后编辑；新增与删除自动保留修订</span></div>
    <div v-if="error" class="margin-error" role="alert"><span>{{ error }}</span><button @click="error = ''" aria-label="关闭错误提示">×</button></div>
    <div v-if="commentFeedback" class="margin-comment-feedback" role="status"><span>{{ commentFeedback }}</span><button v-if="feedbackKind==='comment'" @click="setFilter('comments')">查看全部批注</button><button v-else-if="decisionUndoAvailable" :disabled="saving || exporting" @click="undoDecision">撤销此次操作</button><button @click="commentFeedback=''" :aria-label="feedbackKind==='comment' ? '关闭批注状态提示' : '关闭修订状态提示'">×</button></div>
    <div class="margin-stage" :aria-busy="loading">
      <div class="margin-review-summary"><span class="margin-page-label">合同正文</span><div class="margin-summary-filters"><button :class="{active:activeFilter==='all'}" :aria-pressed="activeFilter==='all'" @click="setFilter('all')">全部 <b>{{ commentCount + changeCount }}</b></button><button :class="{active:activeFilter==='comments'}" :aria-pressed="activeFilter==='comments'" @click="setFilter('comments')">批注 <b>{{ commentCount }}</b></button><button :class="{active:activeFilter==='changes'}" :aria-pressed="activeFilter==='changes'" @click="setFilter('changes')">修订 <b>{{ changeCount }}</b></button><button :class="{active:activeFilter==='resolved'}" :aria-pressed="activeFilter==='resolved'" @click="setFilter('resolved')">已处理 <b>{{ resolvedCount }}</b></button></div></div>
      <div ref="surface" class="margin-document-surface" :style="{width:Math.max(1160,794*zoom/100+350)+'px'}">
        <div ref="host" class="margin-editor-host"></div>
        <ReviewMarginRail ref="rail" :editor="ready ? editor : null" :container="surface" :filter="activeFilter" :readonly="readonly" :visible="viewMode==='markup'" @error="reportError" @handled="handledComment" @decided="decidedRevision" @operation="recordOperation" @counts="value=>{ if(value.comments!=null)commentCount=value.comments; if(value.resolved!=null)resolvedCount=value.resolved; if(value.changes!=null)changeCount=value.changes; }" />
      </div>
      <div v-if="loading" class="margin-loading" role="status"><span></span>正在加载合同、批注与修订…</div>
      <div v-else-if="!ready" class="margin-load-failed"><h2>合同暂时无法打开</h2><p>{{ error }}</p><button @click="loadFile(file,true)">重新加载</button></div>
    </div>
    <footer class="margin-statusbar"><span><i></i>{{ preview ? '本地预览' : `合同版本 v${versionNo}` }}<span class="margin-status-separator">|</span>批注 {{ commentCount }}（待处理 {{ commentCount-resolvedCount }} · 已处理 {{ resolvedCount }}）<span class="margin-status-separator">|</span>待处理修订 {{ changeCount }}</span><span>{{ viewMode==='markup' ? '新增和删除保留痕迹 · 在页边卡片接受或拒绝修订' : '当前为只读对照视图' }}</span></footer>
    <input ref="input" type="file" accept=".docx" hidden @change="importFile" />
  </section>
</template>
