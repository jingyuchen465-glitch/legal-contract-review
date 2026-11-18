<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { ElMessage } from 'element-plus/es/components/message/index.mjs';
import { api } from './api';
import { fileFindings } from './joint-documents.mjs';
import AnnotationNote from './AnnotationNote.vue';
import { activeAnnotations, annotationText } from './annotations.mjs';
import { connectOfficeComments } from './office-links.mjs';

const props = defineProps({ contractId: String, review: Object, reviewVersionNo: Number, sourceVersion: Object, selectedFindingId: String, editable: Boolean, busy: Boolean, annotationAllowed: Boolean, annotationReason: String });
const emit = defineEmits(['close', 'saved', 'select-finding', 'review-finding', 'correct-finding', 'adopt-finding', 'reject-finding', 'generate-annotations']);
const root = ref(), ready = ref(false), error = ref(''), saving = ref(false), pending = ref(false), session = ref(null), savedVersion = ref(null), showNotes = ref(true), fullscreen = ref(false);
const layout = ref(), documentHost = ref(), noteList = ref(), lines = ref([]), activeFindingId = ref(''), linkState = ref('idle'), linkCount = ref(0), linkIndex = ref(0);
const drafts = ref({}), draftingId = ref(''), applying = ref(false), appliedIds = ref([]), reloadNeeded = ref(false);
const drafting = computed(() => !!draftingId.value || applying.value);
const operationName = operation => ({ replace: '替换本段', insert_after: '在本段后新增', delete: '删除本段文字' }[operation]);
const snapshot = props.review ? JSON.parse(JSON.stringify(props.review)) : null;
const review = computed(() => props.review?.id === snapshot?.id ? props.review : snapshot);
const scoped = value => value?.snapshot?.jointGroup ? fileFindings(value.opinionGroups || value.findings,props.sourceVersion.id,value.version_id) : value?.opinionGroups || value?.findings;
const notes = computed(() => activeAnnotations(scoped(review.value)));
const historical = computed(() => !!review.value && ((review.value.version_id !== props.sourceVersion.id && !review.value.snapshot?.jointGroup?.documents.some(d=>d.versionId===props.sourceVersion.id)) || (savedVersion.value && savedVersion.value.versionId !== props.sourceVersion.id)));
const status = computed(() => error.value || (applying.value ? '正在应用条款改稿并保留修订…' : draftingId.value ? '正在保存并生成完整条款改稿…' : !ready.value ? '正在打开合同与批注…' : saving.value ? '正在保存，等待工作台确认…' : pending.value ? '有修改待保存' : savedVersion.value ? `已保存为 v${savedVersion.value.versionNo}，可继续编辑` : '已开启修订，修改后请保存'));
const linkHint = computed(() => ({ idle: '可见条款与意见自动连线；点击“定位原文”可跳转并高亮。', linked: lines.value.some(line => line.findingId === activeFindingId.value) ? '可见条款持续连线，当前选中意见已高亮。' : '已定位；条款或意见在可视区域外时隐藏连线，窄屏保留定位。', missing: '该意见没有可靠定位的原文，请展开引用并结合全文核实。', ambiguous: '文中有多个相同批注，请在 Word 中核实对应位置。', unavailable: '当前编辑器连接不支持连线，请展开引用条款核对。' }[linkState.value]));
let editor, timer, disposed = false, editSequence = 0, bridge, animationFrame, resizeObserver, measuredAt = 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const sessionUrl = () => `/contracts/${props.contractId}/editor/${session.value.key}`;

function noteElement(id) { return [...(noteList.value?.querySelectorAll('[data-link-finding-id]') || [])].find(node => node.dataset.linkFindingId === id); }
function revealNote(id) {
  const card = noteElement(id), list = noteList.value;
  if (!card || !list) return;
  const a = card.getBoundingClientRect(), b = list.getBoundingClientRect();
  if (a.top < b.top || a.top + 72 > b.bottom) list.scrollTop += a.top - b.top - 12;
}
function updateLine(timestamp) {
  if (disposed) return;
  if (timestamp - measuredAt >= 80) {
    measuredAt = timestamp;
    const list = noteList.value?.getBoundingClientRect();
    const cards = new Map();
    if (showNotes.value && list) for (const node of noteList.value.querySelectorAll('[data-link-finding-id]')) {
      const rect = node.getBoundingClientRect();
      if (rect.bottom >= list.top && rect.top <= list.bottom) cards.set(node.dataset.linkFindingId, rect);
    }
    const next = showNotes.value && layout.value && list ? bridge?.measureAll(layout.value.getBoundingClientRect(), cards, list) || [] : [];
    if (JSON.stringify(next) !== JSON.stringify(lines.value)) lines.value = next;
  }
  animationFrame = requestAnimationFrame(updateLine);
}
async function locateFinding(id, next = false) {
  activeFindingId.value = id; emit('select-finding', id);
  const result = bridge?.locate(id, next ? linkIndex.value + 1 : 0) || { state: 'unavailable', count: 0 };
  linkState.value = result.state; linkCount.value = result.count; linkIndex.value = result.index || 0;
  await nextTick(); revealNote(id);
}
function resizeLinks() { bridge?.refresh(); }
watch(() => props.selectedFindingId, id => { if (id && id !== activeFindingId.value && bridge?.available) locateFinding(id); });
watch(showNotes, async shown => { bridge?.setEnabled(shown); if (!shown) lines.value = []; await nextTick(); if (shown) { revealNote(activeFindingId.value); resizeLinks(); } });
async function attachLinks() {
  await nextTick(); if (disposed || bridge) return;
  bridge = connectOfficeComments(documentHost.value, activeAnnotations(scoped(snapshot)), {
    select: (id, info) => { activeFindingId.value = id; linkCount.value = info.count; linkIndex.value = info.index; linkState.value = 'linked'; emit('select-finding', id); nextTick(() => revealNote(id)); },
    position: anchor => { if (anchor) linkState.value = 'linked'; else if (linkState.value === 'linked') linkState.value = 'idle'; },
    unavailable: () => { linkState.value = 'unavailable'; },
  });
  animationFrame = requestAnimationFrame(updateLine);
  resizeObserver = new ResizeObserver(resizeLinks); resizeObserver.observe(documentHost.value);
  window.addEventListener('resize', resizeLinks);
}

async function checkSaved() {
  if (!session.value || disposed) return;
  const value = await api(sessionUrl(), { quiet: true });
  if (!disposed && value.saved) {
    const changed = savedVersion.value?.versionId !== value.versionId;
    savedVersion.value = value;
    if (changed) emit('saved', value);
  }
  return value;
}
async function save(returnToReview = false) {
  if (!ready.value || saving.value) return false;
  // OnlyOffice may not emit a callback for a force-save when the document has
  // no changes. Avoid waiting for a version that will never be created; this
  // is especially important before generating a clause draft from an untouched
  // document.
  if (!pending.value) {
    if (returnToReview) {
      emit('close', savedVersion.value || {
        versionId: session.value?.versionId,
        versionNo: session.value?.versionNo,
        saved: false,
      });
    }
    return true;
  }
  saving.value = true; error.value = '';
  const sequence = editSequence, beforeVersion = savedVersion.value?.versionId || session.value.versionId;
  try {
    // Allow the editor to flush the current keystrokes before force-saving.
    await pause(1200);
    let request = await api(sessionUrl() + '/save', { method: 'POST', body: {}, quiet: true });
    let latest;
    for (let attempt = 0; attempt < 25 && !disposed; attempt++) {
      latest = await checkSaved();
      if (latest.saved && latest.versionId !== beforeVersion) break;
      if (attempt === 24) throw new Error('尚未收到保存确认，请保留编辑器并稍后重试。');
      await pause(1200);
      // OnlyOffice can return error=4 while the last keystrokes are still
      // travelling to its server. A dirty editor needs a verified callback,
      // not a no-change command reply, before its pending flag is cleared.
      if (!request.queued) request = await api(sessionUrl() + '/save', { method: 'POST', body: {}, quiet: true });
    }
    if (disposed) return false;
    pending.value = editSequence !== sequence;
    if (returnToReview && pending.value) {
      ElMessage.info('保存期间又有新的修改，请再次点击“保存并返回”。');
      return false;
    }
    if (returnToReview) emit('close', { versionId: latest.versionId, versionNo: latest.versionNo, saved: latest.saved || savedVersion.value?.versionId === latest.versionId });
    else ElMessage.success(latest.saved ? `修改已保存为 v${latest.versionNo}` : '当前没有需要保存的新修改');
    return true;
  } catch (cause) {
    error.value = cause.message || '保存失败，请保留编辑器并重试。';
    ElMessage.error(error.value); return false;
  } finally { if (!disposed) saving.value = false; }
}
async function close() {
  if (props.busy) return;
  if (drafting.value) { ElMessage.info('条款改稿正在处理中，请完成后再返回。'); return; }
  if (reloadNeeded.value) { emit('close', savedVersion.value); return; }
  if (!ready.value) { emit('close', null); return; }
  await save(true);
}
async function saveForNavigation() {
  if (drafting.value || reloadNeeded.value) { ElMessage.info('请先完成条款改稿或重新打开编辑器。'); return false; }
  if (!ready.value || saving.value) { ElMessage.info('编辑器正在加载或保存，请稍后切换。'); return false; }
  if (!await save(false)) return false;
  if (pending.value) { ElMessage.info('保存期间又有新的修改，请稍后再次切换。'); return false; }
  return savedVersion.value || { saved: false, versionId: session.value?.versionId, versionNo: session.value?.versionNo };
}
async function copySuggestion(finding) {
  try { await navigator.clipboard.writeText(annotationText(finding)); ElMessage.success('已复制修改建议，可粘贴到正文中修订'); }
  catch { ElMessage.info('请选中建议文字后复制。'); }
}
async function generateDraft(finding) {
  if (drafting.value || saving.value || !ready.value) return;
  draftingId.value = finding.id; error.value = '';
  delete drafts.value[finding.id];
  try {
    if (!await save(false)) return;
    if (pending.value) throw new Error('保存期间又有新的修改，请保存完成后重新生成。');
    const sequence = editSequence;
    const draft = await api(sessionUrl() + '/draft', { method: 'POST', body: { reviewId: review.value.id, findingId: finding.id }, quiet: true });
    if (disposed) return;
    if (sequence !== editSequence) throw new Error('生成期间正文有变化，请重新生成改稿。');
    drafts.value[finding.id] = draft;
    await nextTick(); revealNote(finding.id);
  } catch (cause) { if (!disposed) ElMessage.error(cause.message || '条款改稿生成失败，请重试。'); }
  finally { draftingId.value = ''; }
}
async function applyDraft(finding) {
  const draft = drafts.value[finding.id];
  if (!draft || drafting.value || saving.value || !ready.value) return;
  applying.value = true; error.value = '';
  try {
    // Flush all manual edits, even after the preview has been generated. A new
    // saved version invalidates the signed draft rather than overwriting it.
    if (!await save(false)) return;
    if (pending.value) throw new Error('保存期间又有新的修改，请重新生成改稿。');
    const result = await api(sessionUrl() + '/apply-draft', { method: 'POST', body: { token: draft.token }, quiet: true });
    savedVersion.value = result; pending.value = false; ready.value = false; reloadNeeded.value = true;
    drafts.value = {}; appliedIds.value.push(finding.id);
    await reopenEditor();
    emit('saved', result);
    ElMessage.success(`已应用条款改稿并保存为 v${result.versionNo}，可在 Word 中核对增删修订`);
  } catch (cause) {
    if (['DRAFT_STALE', 'DRAFT_EXPIRED', 'DRAFT_ANCHOR_CHANGED'].includes(cause.code)) delete drafts.value[finding.id];
    if (!disposed) ElMessage.error(cause.message || '应用失败，当前编辑内容已保留。');
  } finally { applying.value = false; }
}
async function copyDraft(draft) {
  try { await navigator.clipboard.writeText(draft.edits.filter(e => e.operation !== 'delete').map(e => e.newText).join('\n\n')); ElMessage.success('已复制条款正文'); }
  catch { ElMessage.info('请选中改稿正文后复制。'); }
}
function detachEditor() {
  cancelAnimationFrame(animationFrame); resizeObserver?.disconnect(); bridge?.disconnect(); bridge = null;
  window.removeEventListener('resize', resizeLinks); lines.value = [];
  editor?.destroyEditor(); editor = null;
}
async function mountEditor(value) {
  const expectedVersion = savedVersion.value?.versionId || props.sourceVersion.id;
  if (value.session.versionId !== expectedVersion) throw new Error('编辑文件版本已变化，请刷新并切换到最新版后改稿');
  detachEditor(); ready.value = false;
  session.value = value.session;
  if (!window.DocsAPI) await new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = value.serverUrl + '/web-apps/apps/api/documents/api.js'; script.onload = resolve; script.onerror = () => reject(new Error('编辑器加载失败，请检查服务连接。')); document.head.appendChild(script);
  });
  if (disposed) return;
  editor = new window.DocsAPI.DocEditor('office-editor', { ...value.config, width: '100%', height: '100%', events: {
    onDocumentReady: () => { ready.value = true; error.value = ''; reloadNeeded.value = false; root.value?.scrollIntoView({ block: 'start', behavior: 'smooth' }); attachLinks(); },
    onDocumentStateChange: event => { if (event.data === true) { pending.value = true; editSequence++; } },
    onError: () => { error.value = '编辑器暂时无法处理文档，请保留页面并检查连接。'; },
    onRequestClose: () => close(),
  } });
}
async function reopenEditor() {
  try { const value = await api(`/contracts/${props.contractId}/editor?versionId=${encodeURIComponent(savedVersion.value?.versionId || props.sourceVersion.id)}`, { quiet: true }); if (!disposed) await mountEditor(value); }
  catch (cause) { error.value = `改稿已保存为 v${savedVersion.value?.versionNo}，重新打开编辑器失败：${cause.message}`; }
}
async function toggleFullscreen() {
  try { if (document.fullscreenElement === root.value) await document.exitFullscreen(); else await root.value.requestFullscreen(); }
  catch { ElMessage.info('当前浏览器不支持全屏，可使用浏览器缩放查看。'); }
}
async function reviewAction(event, id) {
  if (document.fullscreenElement === root.value) await document.exitFullscreen();
  emit(event, id);
}
function fullscreenChanged() { fullscreen.value = document.fullscreenElement === root.value; }
function beforeUnload(event) { if (pending.value || saving.value || applying.value) { event.preventDefault(); event.returnValue = ''; } }

onMounted(async () => {
  window.addEventListener('beforeunload', beforeUnload);
  document.addEventListener('fullscreenchange', fullscreenChanged);
  try {
    const query = '?versionId=' + encodeURIComponent(props.sourceVersion.id) + (snapshot?.status === 'completed' && (snapshot.version_id === props.sourceVersion.id || snapshot.snapshot?.jointGroup?.documents.some(d=>d.versionId===props.sourceVersion.id)) ? '&reviewId=' + encodeURIComponent(snapshot.id) : '');
    const value = await api(`/contracts/${props.contractId}/editor${query}`, { quiet: true });
    if (disposed) return;
    await mountEditor(value);
    timer = setInterval(() => { checkSaved().catch(() => {}); }, 5000);
  } catch (cause) { error.value = cause.message || '编辑器不可用，请检查服务连接。'; }
});
onUnmounted(() => { disposed = true; clearInterval(timer); detachEditor(); window.removeEventListener('beforeunload', beforeUnload); document.removeEventListener('fullscreenchange', fullscreenChanged); });
defineExpose({ save, saveForNavigation, hasPending: () => pending.value || saving.value || drafting.value || reloadNeeded.value });
</script>

<template>
  <section ref="root" class="office-workspace" aria-label="合同修订编辑工作区">
    <header class="office-toolbar">
      <div class="office-title"><strong>修订编辑 · v{{ savedVersion?.versionNo || session?.versionNo || sourceVersion.version_no }}</strong><span class="office-mode">默认开启修订</span><small>新增和删除会留下 Word 修订标记</small></div>
      <div class="office-actions"><button type="button" :disabled="!ready||saving||drafting||busy||!annotationAllowed" :title="annotationReason" @click="emit('generate-annotations')">生成批注建议稿</button><small v-if="annotationReason">{{ annotationReason }}</small><button type="button" :aria-pressed="showNotes" @click="showNotes=!showNotes">{{ showNotes?'收起审查意见':'显示审查意见' }}</button><button type="button" @click="toggleFullscreen">{{ fullscreen?'退出全屏':'全屏编辑' }}</button><button type="button" :disabled="!ready||saving||drafting||busy" @click="save(false)">保存修改</button><button type="button" class="primary" :disabled="saving||drafting||busy" @click="close">{{ ready?'保存并返回':'返回旁批' }}</button></div>
    </header>
    <div class="office-status" :class="{ 'office-error': error }" role="status"><span>{{ status }}</span><button v-if="reloadNeeded&&!applying" type="button" @click="reopenEditor">重新打开已保存的改稿</button><a v-if="savedVersion" :href="`/api/files/${savedVersion.versionId}?download=1`">下载含修订的 v{{ savedVersion.versionNo }} ↗</a></div>
    <div ref="layout" class="office-layout" :class="{ 'notes-hidden': !showNotes }">
      <div ref="documentHost" class="office-document" :inert="drafting||reloadNeeded||busy" :aria-busy="drafting||busy"><div id="office-editor"></div></div>
      <svg v-if="lines.length && showNotes" class="office-connectors" aria-label="审查意见与原文的持续连线" data-testid="office-clause-connector"><g v-for="line in lines" :key="line.commentId" :data-finding-id="line.findingId" :data-comment-id="line.commentId" :class="{ 'connector-selected': activeFindingId===line.findingId }"><path :d="line.path" class="connector-halo" /><path :d="line.path" class="connector-stroke" /><circle :cx="line.start.x" :cy="line.start.y" r="4" /><circle :cx="line.end.x" :cy="line.end.y" r="3" /></g></svg>
      <aside v-if="showNotes" class="office-notes" aria-label="编辑时的审查意见">
        <div class="office-notes-heading"><h2>审查意见 <span>{{ notes.length }}</span></h2><p v-if="historical"><b>历史预审意见 · 基于 v{{ reviewVersionNo }}</b><br />以下意见保留供对照，尚未重新验证修改后的正文。</p><p v-else-if="review">基于 v{{ reviewVersionNo }} 的预审。修改后需重新预审，原意见保留供核对。</p><p v-else>本版本尚无已完成的预审，原有 Word 批注仍保留。</p><p v-if="notes.length" class="office-link-help" role="status">{{ linkHint }}</p></div>
        <div ref="noteList" class="office-note-list">
          <section v-for="(finding,index) in notes" :key="finding.id" :data-link-finding-id="finding.id" class="office-review-note" :class="{ 'office-note-linked': lines.some(line=>line.findingId===finding.id), 'office-note-selected': activeFindingId===finding.id }">
            <details v-if="finding.evidence?.length" class="office-quote"><summary>查看引用条款</summary><blockquote v-for="(item,i) in finding.evidence" :key="i">{{ item.quote }}</blockquote></details>
            <AnnotationNote :finding="finding" :number="index+1" :active="selectedFindingId===finding.id" :editable="editable" :busy="busy||drafting" @select="locateFinding($event)" @review="reviewAction('review-finding',$event)" @correct="reviewAction('correct-finding',$event)" @adopt="reviewAction('adopt-finding',$event)" @reject="reviewAction('reject-finding',$event)" />
            <div class="office-note-tools"><button v-if="finding.evidence?.length" type="button" class="office-locate" :disabled="!ready||drafting" @click="locateFinding(finding.id)">定位原文 ↗</button><button v-if="activeFindingId===finding.id && linkCount>1" type="button" class="office-locate" @click="locateFinding(finding.id,true)">下一处 {{ linkIndex+1 }}/{{ linkCount }}</button><button type="button" class="office-copy" @click="copySuggestion(finding)">复制修改建议</button><button v-if="finding.evidence?.length||finding.kind==='missing'" type="button" class="office-draft-button" :disabled="!ready||saving||drafting||busy||appliedIds.includes(finding.id)" @click="generateDraft(finding)">{{ appliedIds.includes(finding.id)?'已应用改稿':draftingId===finding.id?'正在生成改稿…':drafts[finding.id]?'重新生成改稿':'生成完整条款改稿' }}</button></div>
            <section v-if="drafts[finding.id]" class="office-draft" aria-label="条款改稿预览">
              <h3>可直接使用的条款改稿</h3>
              <div v-for="(edit,i) in drafts[finding.id].edits" :key="i" class="office-draft-edit"><strong>{{ operationName(edit.operation) }} · {{ edit.blockId }}</strong><details><summary>{{ edit.operation==='insert_after'?'插入位置原文':'修改前原文' }}</summary><p class="draft-before">{{ edit.originalText }}</p></details><p v-if="edit.operation!=='delete'" class="draft-after">{{ edit.newText }}</p><p v-else class="draft-deleted">本段文字将以删除修订保留。</p></div>
              <details><summary>修改理由与待确认事项</summary><p>{{ drafts[finding.id].explanation }}</p></details><p class="draft-hint">请核对改稿中的【待双方确认】及双语对应内容。应用后将保存新版本并重新打开，增删保留为 Word 修订。</p>
              <div class="draft-actions"><button type="button" class="primary" :disabled="!ready||saving||drafting||busy" @click="applyDraft(finding)">{{ applying?'正在应用…':'应用改稿并保留修订' }}</button><button v-if="drafts[finding.id].edits.some(e=>e.operation!=='delete')" type="button" @click="copyDraft(drafts[finding.id])">复制条款正文</button></div>
            </section>
          </section>
          <div v-if="!notes.length" class="office-empty">暂无需要修改的审查意见。可以直接在左侧修订正文或添加 Word 批注。</div>
        </div>
        <p class="office-notes-foot">“生成完整条款改稿”提供可预览、可应用的合同正文。“认可意见”仅记录复核结果，不会修改正文；应用改稿后仍需重新预审。</p>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.office-draft{margin:0 10px 12px;padding:12px;border:1px solid #bfdbfe;border-radius:5px;background:#f8fbff;font-size:12px;line-height:1.8}.office-draft h3{margin:0 0 10px;font-size:13px;color:#1d4ed8}.office-draft p{white-space:pre-wrap;overflow-wrap:anywhere}.office-draft summary{cursor:pointer;color:#64748b;font-size:11px}.office-draft-edit{border-bottom:1px solid #dbeafe;padding-bottom:8px;margin-bottom:10px}.office-draft-edit>strong{font-size:11px;color:#334155}.draft-before{color:#64748b}.draft-after{padding:9px;background:#fff;border-left:3px solid #22a06b;color:#183d30}.draft-deleted{color:#a54230}.office-draft .draft-hint{font-size:10px;color:#64748b}.draft-actions{display:flex;gap:6px;flex-wrap:wrap}.draft-actions button{font-size:11px;padding:7px 9px}.office-note-tools .office-draft-button{color:#1d4ed8;background:#eff6ff;border-color:#bfdbfe;font-size:11px;padding:7px 9px}.office-document[inert]{opacity:.65}
.office-connectors g{opacity:.68}.office-connectors .connector-selected{opacity:1}.connector-selected .connector-stroke{stroke-width:2.5}.office-note-selected{box-shadow:0 0 0 2px #6b728088!important}
.office-layout{position:relative}.office-connectors{position:absolute;inset:0;width:100%;height:100%;z-index:5;pointer-events:none;overflow:hidden;color:#2563eb}.office-connectors path{fill:none;stroke-linejoin:round;stroke-linecap:round}.connector-halo{stroke:#fff;stroke-width:5;opacity:.9}.connector-stroke{stroke:currentColor;stroke-width:1.8}.office-connectors circle{fill:#fff;stroke:currentColor;stroke-width:2}.office-note-linked{border-color:#6b7280!important;box-shadow:0 0 0 2px #e5e7eb66}.office-note-tools{display:flex;gap:6px;flex-wrap:wrap;padding:0 12px 12px}.office-note-tools .office-copy{margin:0}.office-locate{padding:6px 9px;font-size:11px;color:#2563eb;background:#f3f4f6;border-color:#e5e7eb}.office-notes-heading .office-link-help{color:#2563eb;font-size:10px;line-height:1.7}
.office-workspace{background:#fff;scroll-margin-top:12px}.office-toolbar{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:15px 17px;border-bottom:1px solid #e5e7eb;flex-wrap:wrap}.office-title{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.office-title strong{font-size:15px;color:#2563eb}.office-title small{color:#6b7280;font-size:11px}.office-mode{padding:4px 7px;border-radius:4px;background:#f3f4f6;color:#2563eb;font-size:11px}.office-actions{display:flex;align-items:center;gap:7px;flex-wrap:wrap}.office-actions button{padding:8px 11px;font-size:12px;min-height:36px}.office-status{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:37px;padding:9px 17px;background:#f6f9f7;color:#6b7280;font-size:11px}.office-status a{white-space:nowrap}.office-error{background:#fff3ee;color:#a54230}.office-layout{display:grid;grid-template-columns:minmax(0,1fr) 290px;align-items:stretch}.office-layout.notes-hidden{grid-template-columns:minmax(0,1fr)}.office-document{min-width:0;height:clamp(650px,calc(100vh - 175px),1000px);border-right:1px solid #e5e7eb}.office-document #office-editor{height:100%;width:100%}.office-notes{display:flex;flex-direction:column;min-width:0;max-height:1000px;height:clamp(650px,calc(100vh - 175px),1000px);background:#fafbf9}.office-notes-heading{padding:17px 15px 12px;border-bottom:1px solid #f3f4f6}.office-notes-heading h2{font-size:14px;display:flex;gap:8px;align-items:center}.office-notes-heading h2 span{font-size:11px;font-weight:400;color:#6b7280}.office-notes-heading p{font-size:11px;line-height:1.8;color:#6b7280;margin:8px 0 0}.office-note-list{padding:13px;overflow:auto;flex:1}.office-review-note{background:#fff;border:1px solid #e5e7eb;border-radius:6px;margin-bottom:12px;overflow:hidden}.office-quote{padding:11px 12px 0;font-size:11px;color:#6b7280}.office-quote summary{cursor:pointer}.office-quote blockquote{margin:9px 0;padding:0 0 0 9px;border-left:2px solid #cbd5e1;font-size:11px;line-height:1.8;white-space:pre-wrap}.office-copy{margin:0 12px 12px;padding:6px 9px;font-size:11px;color:#2563eb;background:#fafafa;border-color:#e5e7eb}.office-notes-foot{font-size:10px;color:#6b7280;padding:12px 15px;margin:0;line-height:1.8;border-top:1px solid #f3f4f6}.office-empty{font-size:12px;line-height:1.9;color:#6b7280;padding:20px 5px}.office-workspace:fullscreen{height:100vh;overflow:auto}.office-workspace:fullscreen .office-document,.office-workspace:fullscreen .office-notes{height:calc(100vh - 123px);max-height:none}.office-workspace:fullscreen .office-layout{grid-template-columns:minmax(0,1fr) 320px}.office-workspace:fullscreen .office-layout.notes-hidden{grid-template-columns:minmax(0,1fr)}
@media(max-width:1100px){.office-layout{grid-template-columns:minmax(0,1fr)}.office-notes{height:auto;max-height:440px;border-top:1px solid #e5e7eb}.office-document{border-right:0}.office-note-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}.office-review-note{margin:0}.office-title small{display:none}}
</style>
