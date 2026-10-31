<script setup>
import { computed, watch, ref, nextTick, onBeforeUnmount } from 'vue';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const props = defineProps({ version: Object, evidence: Array, findings: { type: Array, default: () => [] }, annotationMode: { type: String, default: 'side' }, previous: Object });
const documentRoot = ref(), canvas = ref(), searchInput = ref(), page = ref(1), pageCount = ref(1), error = ref(''), busy = ref(false), width = ref(1), height = ref(1), scale = ref(1), fontSize = ref(13), search = ref(''), searchOpen = ref(false), outlineOpen = ref(false), focusMode = ref(false);
let pdf, task, rendering, loadId = 0;
const isPdf = () => props.version?.filename?.toLowerCase().endsWith('.pdf');
const blocks = computed(() => props.version?.parsed?.blocks || []);
const searchTerm = computed(() => search.value.trim().toLowerCase());
const searchCount = computed(() => searchTerm.value ? blocks.value.filter(block => block.text?.toLowerCase().includes(searchTerm.value)).length : 0);
const outlineItems = computed(() => blocks.value.filter(block => block.text?.trim()).filter((block, index) => index < 8 || /^第[一二三四五六七八九十百]+条|^[一二三四五六七八九十]+[、.]/.test(block.text.trim())).slice(0, 12));
function isMatch(block) { return !!searchTerm.value && block.text?.toLowerCase().includes(searchTerm.value); }
function clearSearch() { search.value = ''; }
async function openSearch() { searchOpen.value = true; await nextTick(); searchInput.value?.focus(); }
function jumpToBlock(block) { const target = document.getElementById(`block-${block.id}`); if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
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
  return (props.evidence || []).map(e => props.version?.parsed?.blocks.find(b => b.id === e.blockId)).filter(b => b?.page === page.value && b.bbox).map(b => ({ left: `${b.bbox[0] / b.width * 100}%`, top: `${b.bbox[1] / b.height * 100}%`, width: `${b.bbox[2] / b.width * 100}%`, height: `${Math.max(b.bbox[3] / b.height * 100, 1.2)}%` }));
}
watch(() => props.version?.id, async () => {
  const id = ++loadId; error.value = ''; busy.value = true; search.value = ''; if (task) await task.destroy(); pdf = null;
  try {
    if (isPdf()) { task = pdfjs.getDocument({ url: `/api/files/${props.version.id}`, isEvalSupported: false }); const document = await task.promise; if (id !== loadId) return; pdf = document; pageCount.value = pdf.numPages; page.value = 1; await nextTick(); await render(); }
  } catch { error.value = '预览加载失败，请下载原件核查。'; } finally { if (id === loadId) busy.value = false; }
}, { immediate: true });
watch(page, () => render().catch(() => { error.value = '页面预览失败'; }));
function evidenceKey(evidence) { return evidence?.[0]?.blockId || ''; }
watch(() => { const evidence = props.evidence, block = props.version?.parsed?.blocks.find(b => b.id === evidence?.[0]?.blockId); return `${props.version?.id || ''}:${props.version?.parsed ? 'parsed' : 'pending'}:${block?.id || evidenceKey(evidence)}:${block?.page || ''}`; }, async () => {
  const evidence = props.evidence, block = props.version?.parsed?.blocks.find(b => b.id === evidence?.[0]?.blockId);
  if (block?.page) page.value = block.page; else if (block) { await nextTick(); const target = document.getElementById(`block-${block.id}`); if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
});
function changed(block) { return props.previous?.parsed && !props.previous.parsed.blocks.some(b => b.text === block.text); }
function annotationsFor(block) { return (props.findings || []).filter(f => (f.evidence || []).some(e => e.blockId === block.id) && f.check_status !== 'pass'); }
function findingLabel(f) { return f.disposition?.suggestion ?? f.suggestion ?? f.reason ?? '请结合审查意见核实'; }
onBeforeUnmount(() => { loadId++; task?.destroy(); });
</script>

<template>
  <div ref="documentRoot" class="document-view" :class="{ 'reader-focus': focusMode }">
    <div class="reader-topbar">
      <div class="reader-file"><span class="reader-file-icon">▤</span><div><strong>{{ version?.filename || '合同原文' }}</strong><small>{{ isPdf() ? `PDF · ${pageCount} 页` : '结构化文本 · 已保留条款定位' }}</small></div></div>
      <div class="reader-actions">
        <button class="reader-icon-button" :class="{ active: searchOpen }" title="搜索原文" @click="searchOpen ? clearSearch() : openSearch()">⌕<span class="sr-only">搜索</span></button>
        <button class="reader-icon-button" :class="{ active: outlineOpen }" title="打开定位" @click="outlineOpen = !outlineOpen">☷<span class="sr-only">定位</span></button>
        <span class="reader-divider"></span><button class="reader-icon-button" title="减小字号" @click="adjustFont(-1)">A−</button><span class="reader-font-size">{{ fontSize }}</span><button class="reader-icon-button" title="增大字号" @click="adjustFont(1)">A＋</button>
        <button class="reader-icon-button" :class="{ active: focusMode }" title="专注阅读" @click="focusMode = !focusMode">⤢</button>
        <a v-if="version" class="reader-download" :href="`/api/files/${version.id}?download=1`">下载原件 <span>↗</span></a>
      </div>
    </div>
    <div v-if="searchOpen" class="reader-searchbar"><span class="search-glyph">⌕</span><input ref="searchInput" v-model="search" placeholder="搜索合同原文…" @keydown.esc="searchOpen = false" /><span v-if="searchTerm" class="search-count">{{ searchCount }} 处</span><button v-if="search" class="search-clear" @click="clearSearch">清除</button><button class="search-close" @click="searchOpen = false">关闭</button></div>
    <div v-if="outlineOpen && outlineItems.length" class="reader-outline"><div class="outline-title"><span>快速定位</span><button @click="outlineOpen = false">收起</button></div><button v-for="block in outlineItems" :key="block.id" class="outline-item" @click="jumpToBlock(block)"><span>{{ block.id }}</span><b>{{ block.text.trim().slice(0, 42) }}{{ block.text.trim().length > 42 ? '…' : '' }}</b></button></div>
    <div class="reader-statusline"><span><i class="reader-live-dot"></i>阅读模式</span><span v-if="searchTerm">已筛选 {{ searchCount }} 个段落</span><span v-else-if="annotationMode === 'side'">旁批已开启 · 点击批注可回看风险</span><span v-else-if="annotationMode === 'color'">彩色标记已开启 · 黄色区域为审查建议</span><span v-else>仅显示原文</span></div>
    <div v-if="error" class="notice danger">{{ error }}</div><div v-if="busy" class="reader-loading"><span class="reader-spinner"></span><span>正在整理原文版式…</span></div>
    <template v-if="isPdf()">
      <div class="pdf-controls reader-pager"><button @click="page--" :disabled="page <= 1">‹</button><span><b>{{ String(page).padStart(2, '0') }}</b> / {{ String(pageCount).padStart(2, '0') }}</span><button @click="page++" :disabled="page >= pageCount">›</button></div>
      <div class="pdf-sheet-wrap"><div class="pdf-sheet" :style="{ width: width + 'px', height: height + 'px' }"><canvas ref="canvas"></canvas><i v-for="(rect, i) in evidenceRects()" :key="i" class="pdf-highlight" :style="rect"></i></div><div v-if="annotationMode === 'side'" class="pdf-notes"><article v-for="f in findings.filter(f => (f.evidence || []).some(e => e.blockId && version?.parsed?.blocks.find(b => b.id === e.blockId)?.page === page) && f.check_status !== 'pass')" :key="f.id" class="inline-note" :class="f.severity"><b>{{ f.title }}</b><p>{{ findingLabel(f) }}</p></article></div></div>
    </template>
    <div v-else class="docx-reader-shell"><div class="docx-sheet" :style="{ '--reader-font-size': `${fontSize}px` }">
      <div class="document-disclaimer"><span>结构化原文</span><span>段落与表格已定位</span><span v-if="previous?.parsed">新增 / 修改内容以浅黄标记</span></div>
      <div v-for="block in blocks" :key="block.id" :id="'block-' + block.id" class="text-block" :class="{ selected: evidence?.some(e => e.blockId === block.id), changed: changed(block), annotated: annotationsFor(block).length && annotationMode !== 'plain', 'search-match': isMatch(block) }"><span class="block-anchor">{{ block.id }}<small v-if="block.table">表 {{ block.table }} / 单元格 {{ block.cell }}</small></span><div class="block-copy"><p :class="{ 'color-suggestion': annotationsFor(block).length && annotationMode === 'color' }">{{ block.text }}</p><div v-if="annotationMode === 'side'" class="inline-notes"><article v-for="f in annotationsFor(block)" :key="f.id" class="inline-note" :class="f.severity" @click="$emit('select-finding', f.id)"><b>{{ f.title }}</b><p>{{ findingLabel(f) }}</p></article></div></div></div>
      <div v-if="!version?.parsed" class="empty-state"><span class="empty-icon">⌁</span><h3>原文正在解析</h3><p>文档解析完成后，条款会以可定位的阅读版式显示。</p></div><div v-else-if="searchTerm && !searchCount" class="reader-no-result">没有找到“{{ search }}”<button @click="clearSearch">清除搜索</button></div>
    </div></div>
  </div>
</template>
