<script setup>
import { watch, ref, nextTick, onBeforeUnmount } from 'vue';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
const props = defineProps({ version: Object, evidence: Array, previous: Object });
const documentRoot = ref(), canvas = ref(), page = ref(1), pageCount = ref(1), error = ref(''), busy = ref(false), width = ref(1), height = ref(1), scale = ref(1), highlight = ref([]);
let pdf, task, rendering, loadId = 0;
const isPdf = () => props.version?.filename?.toLowerCase().endsWith('.pdf');
async function render() { if (!pdf || !canvas.value) return; if (rendering) { rendering.cancel(); try { await rendering.promise; } catch {} }
  const p = await pdf.getPage(page.value), v = p.getViewport({ scale: 1 }); scale.value = Math.min(1.4, 680 / v.width); const viewport = p.getViewport({ scale: scale.value }); width.value = viewport.width; height.value = viewport.height;
  canvas.value.width = viewport.width; canvas.value.height = viewport.height; rendering = p.render({ canvasContext: canvas.value.getContext('2d'), viewport }); try { await rendering.promise; } catch (e) { if (e.name !== 'RenderingCancelledException') throw e; }
}
function evidenceRects() { return (props.evidence || []).map(e => props.version?.parsed?.blocks.find(b => b.id===e.blockId)).filter(b => b?.page===page.value && b.bbox).map(b => ({ left: `${b.bbox[0]/b.width*100}%`, top: `${b.bbox[1]/b.height*100}%`, width: `${b.bbox[2]/b.width*100}%`, height: `${Math.max(b.bbox[3]/b.height*100,1.2)}%` })); }
watch(() => props.version?.id, async () => { const id = ++loadId; error.value=''; busy.value=true; if (task) await task.destroy(); pdf=null;
  try { if (isPdf()) { task = pdfjs.getDocument({ url: `/api/files/${props.version.id}`, isEvalSupported: false }); const document = await task.promise; if (id!==loadId) return; pdf=document; pageCount.value=pdf.numPages; page.value=1; await nextTick(); await render(); } } catch { error.value='预览加载失败，请下载原件核查。'; } finally { if(id===loadId)busy.value=false; }
}, { immediate: true });
watch(page, () => render().catch(() => { error.value='页面预览失败'; }));
function evidenceKey(evidence) { return evidence?.[0]?.blockId || ''; }
watch(() => { const evidence = props.evidence, block = props.version?.parsed?.blocks.find(b => b.id===evidence?.[0]?.blockId); return `${props.version?.id || ''}:${props.version?.parsed ? 'parsed' : 'pending'}:${block?.id || evidenceKey(evidence)}:${block?.page || ''}`; }, async () => { const evidence = props.evidence; const block = props.version?.parsed?.blocks.find(b => b.id===evidence?.[0]?.blockId); if (block?.page) { page.value=block.page; } else if (block) { await nextTick(); const target = document.getElementById(`block-${block.id}`), root = documentRoot.value; if (target && root) { const bounds = target.getBoundingClientRect(), view = root.getBoundingClientRect(); if (bounds.top < view.top || bounds.bottom > view.bottom) root.scrollTo({ top: root.scrollTop + bounds.top - view.top - root.clientHeight/2 + bounds.height/2, behavior: 'smooth' }); } } });
function changed(block) { return props.previous?.parsed && !props.previous.parsed.blocks.some(b=>b.text===block.text); }
onBeforeUnmount(() => { loadId++; task?.destroy(); });
</script>
<template><div ref="documentRoot" class="document-view"><div class="document-toolbar"><b>{{ version?.filename }}</b><a v-if="version" :href="`/api/files/${version.id}?download=1`">下载原件 ↗</a></div><div v-if="error" class="notice danger">{{ error }}</div><div v-if="busy" class="empty-state">正在加载原文…</div><template v-if="isPdf()"><div class="pdf-controls"><button @click="page--" :disabled="page<=1">上一页</button><span>{{ page }} / {{ pageCount }}</span><button @click="page++" :disabled="page>=pageCount">下一页</button></div><div class="pdf-sheet" :style="{width:width+'px',height:height+'px'}"><canvas ref="canvas"></canvas><i v-for="(rect,i) in evidenceRects()" :key="i" class="pdf-highlight" :style="rect"></i></div></template><div v-else class="docx-sheet"><div class="document-disclaimer">结构化原文 · 段落与表格定位 <span v-if="previous?.parsed">· 新增/修改内容以浅黄标记</span></div><div v-for="block in version?.parsed?.blocks || []" :key="block.id" :id="'block-'+block.id" class="text-block" :class="{selected:evidence?.some(e=>e.blockId===block.id),changed:changed(block)}"><span class="block-anchor">{{ block.id }}<small v-if="block.table">表 {{ block.table }} / 单元格 {{ block.cell }}</small></span><p>{{ block.text }}</p></div><div v-if="!version?.parsed" class="empty-state">文档尚未解析。可先下载原件，处理完成后将显示结构化内容。</div></div></div></template>
