<script setup>
import { ref, watch, onBeforeUnmount, nextTick } from 'vue';

const props = defineProps({ editor: Object, container: Object, filter: String, readonly: Boolean, visible: Boolean });
const emit = defineEmits(['error', 'counts', 'handled', 'decided', 'operation']);
const cards = ref([]), width = ref(0), height = ref(0), railLeft = ref(0), active = ref(''), expanded = ref(''), pending = ref('');
const composer = ref(null), draft = ref(''), composing = ref(false);
const resolvedCount = ref(0);
let comments = [], changes = [], stops = [], frame, resize, capture;
const nodes = new Map();
function schedule() { if (!frame) frame = requestAnimationFrame(layout); }
function setNode(id, node) { if (node) { nodes.set(id, node); resize?.observe(node); } else nodes.delete(id); }
function geometry(item) {
  const viewport = props.editor.ui.viewport;
  let result = viewport.getRect({ target: item.target || item.address, relativeTo: props.container });
  // Imported replacement groups expose a real paragraph navigation target.
  // Anchor at that paragraph's first character when entity geometry is unavailable.
  if (!result.found && item.navigationTarget?.blockId) result = viewport.getRect({ target: {
    kind: 'text', coordinateSpace: 'tracked', segments: [{ blockId: item.navigationTarget.blockId, range: { start: 0, end: 1 } }],
  }, relativeTo: props.container });
  return result.rect;
}
function layout() {
  frame = null;
  if (!props.editor || !props.container || !props.visible) { cards.value = []; return; }
  const box = props.container.getBoundingClientRect(), page = props.container.querySelector('.ts-page');
  if (!page) return;
  railLeft.value = page.getBoundingClientRect().right - box.left + 1;
  width.value = props.container.scrollWidth;
  const items = [
    ...comments.filter(c => !c.parentCommentId).map(c => ({ ...c, kind: 'comment', key: `c:${c.id}` })),
    ...changes.map(c => ({ ...c, kind: 'change', key: `t:${c.id}` })),
  ].filter(c => props.filter === 'all' || (props.filter === 'comments' ? c.kind === 'comment' : props.filter === 'resolved' ? c.kind === 'comment' && c.status === 'resolved' : c.kind === 'change'));
  const positioned = items.map(item => ({ ...item, anchor: geometry(item) })).filter(item => item.anchor);
  positioned.sort((a, b) => a.anchor.top - b.anchor.top || (a.kind === b.kind ? a.key.localeCompare(b.key) : a.kind === 'change' ? -1 : 1));
  let bottom = 16;
  cards.value = positioned.map(item => {
    const y = Math.max(item.anchor.top - 8, bottom), node = nodes.get(item.key);
    bottom = y + (node?.offsetHeight || (item.kind === 'change' ? 150 : 116)) + 12;
    const x = Math.min(item.anchor.right, railLeft.value - 25), ay = item.anchor.bottom - 2;
    return { ...item, y, path: `M ${x} ${ay} L ${railLeft.value - 28} ${ay} L ${railLeft.value + 10} ${y + 20}` };
  });
  height.value = Math.max(props.container.querySelector('.superdoc')?.offsetHeight || 0, bottom + 20);
}
function verify(result) {
  if (result === false || result == null || result?.success === false || result?.ok === false) {
    throw new Error(result?.message || result?.reason || result?.error?.message || '本次操作未完成，请重试');
  }
  return result;
}
async function focus(card) {
  active.value = card.key;
  try {
    if (card.kind === 'comment') {
      props.editor.ui.comments.setActive(card.id);
      verify(await props.editor.ui.comments.scrollTo(card.id));
    } else {
      props.editor.ui.trackChanges.setActive(card.id);
      verify(await props.editor.ui.trackChanges.scrollTo(card.id));
    }
    schedule();
  } catch (error) { emit('error', error); }
}
async function decide(card, accept) {
  if (pending.value || props.readonly) return;
  pending.value = card.key;
  try {
    verify(await props.editor.ui.trackChanges[accept ? 'acceptAsync' : 'rejectAsync'](card.id));
    emit('operation', { action: accept ? 'accept' : 'reject', insertedText: card.insertedText || (['insert', 'insertion'].includes(card.type) ? card.excerpt : '') || '', deletedText: card.deletedText || (['delete', 'deletion'].includes(card.type) ? card.excerpt : '') || '' });
    emit('decided', accept);
  }
  catch (error) { emit('error', error); }
  finally { pending.value = ''; schedule(); }
}
async function setResolved(card, resolved) {
  if (pending.value || props.readonly) return;
  pending.value = card.key;
  try {
    verify(await props.editor.ui.comments[resolved ? 'resolve' : 'reopen'](card.id));
    emit('handled', resolved ? '已标记为已处理，批注仍保留，正文未改动。处理状态会随文档一起保存。' : '已重新打开，批注恢复为待处理。处理状态会随文档一起保存。');
  }
  catch (error) { emit('error', error); }
  finally { pending.value = ''; schedule(); }
}
function addComment() {
  capture = props.editor?.ui.selection.capture();
  if (!capture) { emit('error', new Error('请先在正文中选中要批注的文字')); return; }
  draft.value = ''; composing.value = true;
  nextTick(() => composer.value?.focus());
}
function reply(card) { capture = { replyTo: card.id }; draft.value = ''; composing.value = true; nextTick(() => composer.value?.focus()); }
async function submitComment() {
  if (!draft.value.trim() || pending.value) return;
  pending.value = 'composer';
  try {
    const api = props.editor.ui.comments;
    verify(await (capture.replyTo ? api.reply(capture.replyTo, { text: draft.value.trim() }) : api.createFromCapture(capture, { text: draft.value.trim() })));
    composing.value = false; draft.value = ''; schedule();
  } catch (error) { emit('error', error); }
  finally { pending.value = ''; }
}
function date(value) { if (!value) return ''; const d = new Date(value); return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false }); }
function teardown() { stops.splice(0).forEach(stop => stop()); resize?.disconnect(); cancelAnimationFrame(frame); frame = null; }
watch(() => props.editor, editor => {
  teardown(); comments = []; changes = []; cards.value = []; resolvedCount.value = 0;
  emit('counts', { comments: 0, resolved: 0, changes: 0 });
  if (!editor) return;
  resize = new ResizeObserver(schedule);
  if (props.container) resize.observe(props.container);
  stops.push(editor.ui.comments.observe(snapshot => {
    comments = snapshot.items || [];
    const roots = comments.filter(c => !c.parentCommentId);
    resolvedCount.value = roots.filter(c => c.status === 'resolved').length;
    emit('counts', { comments: roots.length, resolved: resolvedCount.value });
    if (snapshot.activeId != null) active.value = `c:${snapshot.activeId}`;
    schedule();
  }));
  stops.push(editor.ui.trackChanges.observe(snapshot => { changes = snapshot.items || []; emit('counts', { changes: changes.length }); schedule(); }));
  stops.push(editor.ui.viewport.observe(schedule));
  window.addEventListener('resize', schedule);
  document.addEventListener('scroll', schedule, true);
  stops.push(() => { window.removeEventListener('resize', schedule); document.removeEventListener('scroll', schedule, true); });
  schedule();
}, { immediate: true });
watch(() => [props.filter, props.visible, expanded.value], schedule);
onBeforeUnmount(teardown);
defineExpose({ addComment });
</script>

<template>
  <div v-if="visible" class="review-margin-layer" :style="{height:height+'px'}">
    <div class="review-margin-paper" :style="{left:railLeft+'px',height:height+'px'}"></div>
    <div v-if="filter==='resolved' && !resolvedCount" class="review-margin-empty" :style="{left:(railLeft+10)+'px'}"><strong>暂无已处理批注</strong><p>标记后可在这里查看，也可以重新打开。</p></div>
    <svg class="review-margin-connectors" :width="width" :height="height" aria-hidden="true"><path v-for="card in cards" :key="card.key" :d="card.path" :class="[card.kind,{active:active===card.key}]" /></svg>
    <article v-for="card in cards" :key="card.key" :ref="node=>setNode(card.key,node)" class="review-margin-card" :class="[card.kind,{active:active===card.key,expanded:expanded===card.key,resolved:card.kind==='comment' && card.status==='resolved'}]" :style="{left:(railLeft+10)+'px',top:card.y+'px'}" :data-review-id="card.id" :data-comment-status="card.kind==='comment' ? card.status : undefined" tabindex="0" :aria-label="`${card.kind==='comment'?(card.status==='resolved'?'已处理批注':'待处理批注'):'修订'}：${card.creatorName || card.author || '文档审阅人'}`" @click="focus(card)" @keydown.enter.self="focus(card)">
      <header><span class="review-margin-avatar" aria-hidden="true"><svg viewBox="0 0 20 20"><circle cx="10" cy="6" r="3"/><path d="M4 17v-3a6 6 0 0 1 12 0v3z"/></svg></span><div class="review-margin-meta"><strong>{{ card.creatorName || card.author || '文档审阅人' }}</strong><time>{{ date(card.createdTime || card.date) }}</time></div></header>
      <template v-if="card.kind==='comment'"><span v-if="card.status==='resolved'" class="review-comment-status">✓ 已处理</span><p class="review-margin-body">{{ card.text }}</p><template v-if="expanded===card.key"><p v-for="r in comments.filter(c=>c.parentCommentId===card.id)" :key="r.id" class="review-margin-reply"><strong>{{ r.creatorName }}</strong>：{{ r.text }}</p></template></template>
      <template v-else><p class="review-margin-change-label">{{ card.type==='replacement' ? '替换正文' : card.type==='delete' || card.type==='deletion' ? '删除正文' : '正文修订' }}</p><p v-if="card.deletedText" class="review-margin-deleted">删除：{{ card.deletedText }}</p><p v-if="card.insertedText" class="review-margin-inserted">插入：{{ card.insertedText }}</p><p v-if="!card.deletedText && !card.insertedText" class="review-margin-body">{{ card.excerpt }}</p></template>
      <footer><button @click.stop="expanded=expanded===card.key?'':card.key">{{ expanded===card.key?'收起':'展开' }}{{ card.replyCount ? ` · ${card.replyCount} 条回复` : '' }}</button><span v-if="card.kind==='comment' && !readonly"><button v-if="card.status!=='resolved'" @click.stop="reply(card)">回复</button><button :disabled="!!pending" :title="card.status==='resolved' ? '恢复为待处理批注' : '仅标记批注处理状态，不修改正文或确认法务结论'" @click.stop="setResolved(card,card.status!=='resolved')">{{ pending===card.key ? '处理中…' : card.status==='resolved' ? '重新打开' : '标记为已处理' }}</button></span><span v-else-if="card.kind==='change' && !readonly"><button title="接受此处修订" aria-label="接受此处修订" :disabled="!!pending" @click.stop="decide(card,true)">{{ pending===card.key ? '处理中…' : '接受修订' }}</button><button title="拒绝此处修订" aria-label="拒绝此处修订" :disabled="!!pending" @click.stop="decide(card,false)">拒绝修订</button></span><span v-else-if="card.kind==='change'">只读修订</span></footer>
    </article>
  </div>
  <div v-if="composing" class="review-comment-backdrop" @click.self="composing=false"><form class="review-comment-composer" @submit.prevent="submitComment"><h2>{{ capture?.replyTo ? '回复批注' : '添加批注' }}</h2><textarea ref="composer" v-model="draft" maxlength="10000" rows="5" placeholder="填写审阅意见…" aria-label="批注内容" @keydown.esc="composing=false"></textarea><div><button type="button" @click="composing=false">取消</button><button type="submit" :disabled="!draft.trim() || !!pending">{{ pending ? '提交中…' : '保存批注' }}</button></div></form></div>
</template>
