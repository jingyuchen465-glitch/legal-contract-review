<script setup>
import { computed, watch, ref, nextTick, onBeforeUnmount } from 'vue';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import AnnotationNote from './AnnotationNote.vue';
import { annotationIndex, quoteSegments, annotationSeverity } from './annotations.mjs';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const props = defineProps({ version: Object, evidence: Array, findings: { type: Array, default: () => [] }, annotationMode: { type: String, default: 'side' }, selectedFindingId: String, locationRequest: Object, editable: Boolean, saving: Boolean, previous: Object, annotationDownloadAvailable: Boolean, annotationDownloadReady: Boolean, downloadingAnnotations: Boolean });
const emit = defineEmits(['select-finding', 'review-finding', 'correct-finding', 'adopt-finding', 'reject-finding', 'download-annotated']);
const documentRoot = ref(), canvas = ref(), searchInput = ref(), page = ref(1), pageCount = ref(1), error = ref(''), busy = ref(false), width = ref(1), height = ref(1), scale = ref(1), fontSize = ref(13), search = ref(''), searchOpen = ref(false), outlineOpen = ref(false), focusMode = ref(false);
let pdf, task, rendering, loadId = 0;
const isPdf = () => props.version?.filename?.toLowerCase().endsWith('.pdf') || props.version?.parsed?.format === 'pdf';
const blocks = computed(() => props.version?.parsed?.blocks || []);
const index = computed(() => annotationIndex(blocks.value, props.findings));
const annotations = computed(() => index.value.annotations);
const unanchored = computed(() => index.value.unanchored);
const pageAnnotations = computed(() => annotations.value.filter(f => blocks.value.find(b => b.id === index.value.primary.get(f.id))?.page === page.value));
const searchTerm = computed(() => search.value.trim().toLowerCase());
const searchCount = computed(() => searchTerm.value ? blocks.value.filter(block => block.text?.toLowerCase().includes(searchTerm.value)).length : 0);
const outlineItems = computed(() => blocks.value.filter(block => block.text?.trim()).filter((block, index) => index < 8 || /^第[一二三四五六七八九十百]+条|^[一二三四五六七八九十]+[、.]/.test(block.text.trim())).slice(0, 12));
function isMatch(block) { return !!searchTerm.value && block.text?.toLowerCase().includes(searchTerm.value); }
function clearSearch() { search.value = ''; }
async function openSearch() { searchOpen.value = true; await nextTick(); searchInput.value?.focus(); }
function scrollToElement(target) {
  const root = documentRoot.value;
  if (target && root) root.scrollTo({ top: Math.max(0, root.scrollTop + target.getBoundingClientRect().top - root.getBoundingClientRect().top - 100), behavior: 'smooth' });
}
function jumpToBlock(block) {
  if (isPdf() && block.page) page.value = block.page;
  else scrollToElement(documentRoot.value?.querySelector(`[data-block-id="${block.id}"]`));
}
async function locateFinding(id, evidence) {
  const citations = props.findings.find(f => f.id === id)?.evidence || props.evidence || [];
  const matches = e => (!e.versionId || e.versionId === props.version?.id) && blocks.value.find(b => b.id === e.blockId && (!e.quote || b.text?.includes(e.quote)));
  // An explicit citation is authoritative; it must not silently jump to another
  // citation (or a block with the same ID in a different material).
  const block = evidence ? matches(evidence) : citations.map(matches).find(Boolean);
  if (isPdf() && block?.page) { page.value = block.page; await nextTick(); scrollToElement(documentRoot.value?.querySelector('.pdf-sheet-wrap')); }
  else { await nextTick(); scrollToElement(block ? documentRoot.value?.querySelector(`[data-block-id="${block.id}"]`) : documentRoot.value?.querySelector('.unanchored-notes')); }
}
function selectFinding(id) { emit('select-finding', id); locateFinding(id); }
function adjustFont(delta) { fontSize.value = Math.min(18, Math.max(12, fontSize.value + delta)); }
async function render() {
  if (!pdf || !canvas.value) return;
  if (rendering) { rendering.cancel(); try { await rendering.promise; } catch {} }
  const current = await pdf.getPage(page.value), base = current.getViewport({ scale: 1 });
  scale.value = Math.min(1.4, 680 / base.width);
  const viewport = current.getViewport({ scale: scale.value });
  width.value = viewport.width; height.value = viewport.height; canvas.value.width = viewport.width; canvas.value.height = viewport.height;
  rendering = current.render({ canvasContext: canvas.value.getContext('2d'), viewport });
  try { await rendering.promise; } catch (e) { if (e.name !== 'RenderingCancelledException') throw e; }
}
function evidenceRects() {
  const items = props.annotationMode !== 'plain' ? annotations.value.flatMap(f => (f.evidence || []).map(e => ({ ...e, severity: annotationSeverity(f), findingId: f.id }))) : [];
  return items.map(e => ({ block: blocks.value.find(b => b.id === e.blockId && e.quote && b.text.includes(e.quote)), severity: e.severity, findingId: e.findingId })).filter(({ block: b }) => b?.page === page.value && b.bbox && b.width && b.height).map(({ block: b, severity, findingId }) => ({ severity, findingId, style: { left: `${b.bbox[0] / b.width * 100}%`, top: `${b.bbox[1] / b.height * 100}%`, width: `${b.bbox[2] / b.width * 100}%`, height: `${Math.max(b.bbox[3] / b.height * 100, 1.2)}%` } }));
}
watch(() => `${props.version?.id}:${isPdf()}:${props.version?.conversion?.status}`, async () => {
  const id = ++loadId; error.value = ''; busy.value = true; search.value = ''; if (task) await task.destroy(); pdf = null;
  try {
    if (isPdf()) { task = pdfjs.getDocument({ url: `/api/files/${props.version.id}${props.version.conversion?.artifacts?.pdf ? '?variant=pdf' : ''}`, isEvalSupported: false }); const document = await task.promise; if (id !== loadId) return; pdf = document; pageCount.value = pdf.numPages; page.value = 1; await nextTick(); await render(); }
  } catch { error.value = '预览加载失败，请下载原件核查。'; } finally { if (id === loadId) busy.value = false; }
}, { immediate: true });
watch(page, () => render().catch(() => { error.value = '页面预览失败'; }));
// Compare navigation sources individually. Polling replaces version/parsed
// objects with equivalent data; a getter returning a fresh array would replay
// the last jump on every refresh and override the user's reading position.
watch([() => props.version?.id, () => props.selectedFindingId, () => blocks.value.length, () => props.annotationMode, () => props.locationRequest, busy], () => {
  if (props.selectedFindingId && !busy.value) locateFinding(props.selectedFindingId, props.locationRequest?.findingId === props.selectedFindingId ? props.locationRequest.evidence : undefined);
}, { immediate: true, flush: 'post' });
function changed(block) { return props.previous?.parsed && !props.previous.parsed.blocks.some(b => b.text === block.text); }
function annotationsFor(block) { return index.value.byBlock.get(block.id) || []; }
function primaryNotes(block) { return index.value.primaryByBlock.get(block.id) || []; }
function linkedNotes(block) { return annotationsFor(block).filter(f => index.value.primary.get(f.id) !== block.id); }
function noteProps(f) { return { finding: f, color: props.annotationMode === 'color', active: f.id === props.selectedFindingId, editable: props.editable, busy: props.saving, number: index.value.numbers.get(f.id) }; }
onBeforeUnmount(() => { loadId++; task?.destroy(); });
</script>

<template>
  <div ref="documentRoot" class="document-view" :class="{ 'reader-focus': focusMode, 'reader-side': annotationMode === 'side', 'reader-color': annotationMode === 'color' }">
    <div class="reader-topbar">
      <div class="reader-file"><span class="reader-file-icon">▤</span><div><strong>{{ version?.filename || '合同原文' }}</strong><small>{{ isPdf() ? `PDF · ${pageCount} 页` : version?.parsed?.format==='spreadsheet'?'表格内容 · 工作表及单元格定位':'结构化文本 · 已保留条款定位' }}</small></div></div>
      <div class="reader-actions">
        <button class="reader-icon-button" :class="{ active: searchOpen }" title="搜索原文" @click="searchOpen ? clearSearch() : openSearch()">⌕<span class="sr-only">搜索</span></button>
        <button class="reader-icon-button" :class="{ active: outlineOpen }" title="打开定位" @click="outlineOpen = !outlineOpen">☷<span class="sr-only">定位</span></button>
        <span class="reader-divider"></span><button class="reader-icon-button" title="减小字号" @click="adjustFont(-1)">A−</button><span class="reader-font-size">{{ fontSize }}</span><button class="reader-icon-button" title="增大字号" @click="adjustFont(1)">A＋</button>
        <button class="reader-icon-button" :class="{ active: focusMode }" title="专注阅读" @click="focusMode = !focusMode">⤢</button>
        <button v-if="annotationDownloadAvailable" class="reader-download reader-download-annotated" :disabled="!annotationDownloadReady || downloadingAnnotations" :title="annotationDownloadReady ? '将审查意见保存为 Word 原生批注，下载到本机后仍可查看' : '预审完成后可下载带批注的合同'" @click="emit('download-annotated')">{{ downloadingAnnotations ? '正在生成…' : '下载批注版' }} <span>↓</span></button>
        <a v-if="version" class="reader-download" title="下载上传的文件，不附加本次 AI 审查批注" :href="`/api/files/${version.id}?download=1`">下载原件 <span>↗</span></a>
      </div>
    </div>
    <div v-if="searchOpen" class="reader-searchbar"><span class="search-glyph">⌕</span><input ref="searchInput" v-model="search" placeholder="搜索合同原文…" @keydown.esc="searchOpen = false" /><span v-if="searchTerm" class="search-count">{{ searchCount }} 处</span><button v-if="search" class="search-clear" @click="clearSearch">清除</button><button class="search-close" @click="searchOpen = false">关闭</button></div>
    <div v-if="outlineOpen && outlineItems.length" class="reader-outline"><div class="outline-title"><span>快速定位</span><button @click="outlineOpen = false">收起</button></div><button v-for="block in outlineItems" :key="block.id" class="outline-item" @click="jumpToBlock(block)"><span>{{ block.id }}</span><b>{{ block.text.trim().slice(0, 42) }}{{ block.text.trim().length > 42 ? '…' : '' }}</b></button></div>
    <div class="reader-statusline"><span><i class="reader-live-dot"></i>{{ annotationMode === 'plain' ? '原文阅读' : '在原文上审核' }}</span><span v-if="searchTerm">找到 {{ searchCount }} 个段落</span><span v-else-if="annotationMode === 'side'">{{ annotations.length }} 条意见 · 批注与条款并排，点击编号可定位</span><span v-else-if="annotationMode === 'color'">原文引用与建议同处显示 · 红色高风险 / 蓝色其他建议</span><span v-else>仅显示合同正文</span></div>
    <details v-if="version?.parsed?.originalComments?.length || version?.parsed?.revisions?.length" class="notice source-markup">
      <summary>查看原件已有旁批 {{ version.parsed.originalComments?.length||0 }} 条、修订 {{ version.parsed.revisions?.length||0 }} 处</summary>
      <p>以下来自上传的 Word；正文采用当前文本视图（含插入、不含删除）。</p>
      <article v-for="comment in version.parsed.originalComments" :key="comment.id"><b>原有旁批 · {{ comment.author||'未署名' }}</b><p class="prewrap">{{ comment.text }}</p><button v-for="id in comment.blockIds" :key="id" class="text-btn" @click="jumpToBlock(blocks.find(b=>b.id===id))">定位 {{ id }}</button></article>
      <article v-for="(revision,i) in version.parsed.revisions" :key="i"><b>{{ {insert:'插入',delete:'删除',move_from:'移出',move_to:'移入'}[revision.type] }} · {{ revision.author||'未署名' }}</b><p class="prewrap">{{ revision.text }}</p></article>
    </details>
    <div v-if="error" class="notice danger">{{ error }}</div><div v-if="busy" class="reader-loading"><span class="reader-spinner"></span><span>正在整理原文版式…</span></div>
    <template v-if="isPdf()">
      <div class="pdf-controls reader-pager"><button @click="page--" :disabled="page <= 1">‹</button><span><b>{{ String(page).padStart(2, '0') }}</b> / {{ String(pageCount).padStart(2, '0') }}</span><button @click="page++" :disabled="page >= pageCount">›</button></div>
      <div class="pdf-sheet-wrap"><div class="pdf-sheet" :style="{ width: width + 'px', height: height + 'px' }"><canvas ref="canvas"></canvas><button v-for="(rect, i) in evidenceRects()" :key="i" type="button" class="pdf-highlight" :class="[rect.severity, { 'quote-active': rect.findingId === selectedFindingId }]" :style="rect.style" :aria-label="`定位批注 ${index.numbers.get(rect.findingId)}`" @click="selectFinding(rect.findingId)"></button></div><div v-if="annotationMode !== 'plain'" class="pdf-notes"><AnnotationNote v-for="f in pageAnnotations" :key="f.id" v-bind="noteProps(f)" @select="selectFinding" @review="$emit('review-finding', $event)" @correct="$emit('correct-finding', $event)" @adopt="$emit('adopt-finding', $event)" @reject="$emit('reject-finding', $event)" /><div class="linked-notes"><button v-for="f in annotations.filter(f => !pageAnnotations.includes(f) && (f.evidence || []).some(e => blocks.find(b => b.id === e.blockId)?.page === page))" :key="f.id" @click="selectFinding(f.id)">关联批注 {{ String(index.numbers.get(f.id)).padStart(2, '0') }} ↗</button></div></div></div>
    </template>
    <div v-else class="docx-reader-shell"><div class="docx-sheet" :style="{ '--reader-font-size': `${fontSize}px` }">
      <div class="document-disclaimer"><span>合同原文</span><span v-if="annotationMode === 'side'">右侧为对应条款的审查批注</span><span v-else-if="annotationMode === 'color'">彩色文字为修改建议</span><span v-if="previous?.parsed">版本差异以浅黄标记</span></div>
      <div v-for="(block, blockIndex) in blocks" :key="block.id" :data-block-id="block.id" class="text-block" :class="{ selected: evidence?.some(e => e.blockId === block.id), changed: changed(block), annotated: annotationsFor(block).length && annotationMode !== 'plain', 'search-match': isMatch(block) }">
        <span class="block-anchor">{{ String(blockIndex + 1).padStart(2, '0') }}<small v-if="block.sheet">{{ block.sheet }} / {{ block.address }}</small><small v-else-if="block.table">表 {{ block.table }} / 单元格 {{ block.cell }}</small></span>
        <div class="block-copy" :class="{ 'with-side-notes': annotationMode === 'side' }">
          <div class="clause-original"><p class="original-text"><template v-if="annotationMode !== 'plain'"><template v-for="part in quoteSegments(block, annotations)" :key="part.start"><mark v-if="part.severity" role="button" tabindex="0" class="quote-mark" :class="[part.severity, { 'quote-active': part.findingIds.includes(selectedFindingId) }]" :aria-label="`查看批注 ${part.findingIds.map(id => index.numbers.get(id)).join('、')}`" @click="selectFinding(part.findingIds.includes(selectedFindingId) ? selectedFindingId : part.findingIds[0])" @keydown.enter.prevent="selectFinding(part.findingIds[0])" @keydown.space.prevent="selectFinding(part.findingIds[0])">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></template><template v-else>{{ block.text }}</template></p>
            <div v-if="annotationMode !== 'plain'" class="linked-notes"><button v-for="f in linkedNotes(block)" :key="f.id" :class="{ active: f.id === selectedFindingId }" @click="selectFinding(f.id)">关联批注 {{ String(index.numbers.get(f.id)).padStart(2, '0') }} ↗</button></div>
          </div>
          <div v-if="annotationMode !== 'plain' && primaryNotes(block).length" class="inline-notes"><AnnotationNote v-for="f in primaryNotes(block)" :key="f.id" v-bind="noteProps(f)" @select="selectFinding" @review="$emit('review-finding', $event)" @correct="$emit('correct-finding', $event)" @adopt="$emit('adopt-finding', $event)" @reject="$emit('reject-finding', $event)" /></div>
        </div>
      </div>
      <div v-if="!version?.parsed" class="empty-state"><span class="empty-icon">⌁</span><h3>{{ version?.conversion?.status==='failed'?'文件转换未完成':version?.conversion?'正在准备文件预览':'原文正在解析' }}</h3><p>{{ version?.conversion?.status==='failed'?version.conversion.message:'文档处理完成后会显示可定位的阅读内容，原件可随时下载。' }}</p></div><div v-else-if="searchTerm && !searchCount" class="reader-no-result">没有找到“{{ search }}”<button @click="clearSearch">清除搜索</button></div>
    </div></div>
    <aside v-if="annotationMode !== 'plain' && unanchored.length" class="unanchored-notes"><h4>全文意见 / 位置待核实 <small>{{ unanchored.length }} 项</small></h4><p>缺失条款没有可对应的原文位置；以下意见需结合全文处理。</p><template v-for="f in unanchored" :key="f.id"><button v-if="index.primary.has(f.id)" class="partial-note-link" @click="selectFinding(f.id)">批注 {{ String(index.numbers.get(f.id)).padStart(2, '0') }}：部分引用无法定位，请核实 ↗</button><AnnotationNote v-else v-bind="noteProps(f)" @select="selectFinding" @review="$emit('review-finding', $event)" @correct="$emit('correct-finding', $event)" @adopt="$emit('adopt-finding', $event)" @reject="$emit('reject-finding', $event)" /></template></aside>
  </div>
</template>
