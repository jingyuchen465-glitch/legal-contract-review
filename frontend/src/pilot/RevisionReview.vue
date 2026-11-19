<script setup>
import { computed } from 'vue';
const props = defineProps({ report: Object, baseline: Object });
defineEmits(['locate']);
const review = computed(() => props.report?.revisionReview);
const states = { resolved: '已解决', partial: '部分解决', unresolved: '未解决', accepted: '保留法务处理', uncertain: '待核实' };
const origins = { introduced_by_edit: '修改引入', previously_missed: '上轮漏检', new_material: '材料或背景变化', changed_assessment: '判断修正' };
const previous = id => props.baseline?.findings?.find(f => f.id === id);
const legalReason = id => { const f = previous(id); return (f?.disposition || f?.priorDisposition)?.reason; };
const counts = computed(() => {
  const items = review.value?.items || [];
  return { resolved: items.filter(i => i.status === 'resolved').length, accepted: items.filter(i => i.status === 'accepted').length,
    pending: items.filter(i => !['resolved', 'accepted'].includes(i.status)).length, added: review.value?.newFindings.length || 0 };
});
</script>

<template>
  <section v-if="review" class="revision-review" aria-label="修改复核结果">
    <h2>修改复核</h2>
    <p class="revision-counts">对照 v{{ baseline?.versionNo }} · 已解决 {{ counts.resolved }} · 保留法务处理 {{ counts.accepted }} · 仍待处理 {{ counts.pending }} · 新增问题 {{ counts.added }}</p>
    <p v-if="!counts.pending && !counts.added" class="notice">本轮复核未列出仍待处理或新增问题，请结合审查概览与核验限制确认法务结论。</p>
    <details v-for="item in review.items" :key="item.previousFindingId" :open="!['resolved','accepted'].includes(item.status)">
      <summary><span class="revision-state" :class="item.status">{{ states[item.status] }}</span>{{ previous(item.previousFindingId)?.title || '上轮问题' }}</summary>
      <p>{{ item.reason }}</p>
      <p v-if="legalReason(item.previousFindingId)" class="muted">原法务处理：{{ legalReason(item.previousFindingId) }}</p>
      <p v-if="item.reopenReason"><b>重新提出的依据：</b>{{ item.reopenReason }}</p>
      <button v-for="e in item.evidence" :key="e.versionId+e.blockId+e.quote" type="button" class="revision-evidence" @click="$emit('locate', e)">{{ e.quote }}<small>定位当前原文 ↗</small></button>
    </details>
    <div v-if="review.newFindings.length" class="revision-new">
      <h3>新增问题及原因</h3>
      <article v-for="item in review.newFindings" :key="item.findingIndex"><p><b>{{ origins[item.origin] }} · {{ report.findings[item.findingIndex]?.title }}</b></p><p>{{ item.reason }}</p></article>
    </div>
    <small>认可修改建议不代表正文已修改；本轮复核不代替最终法务结论。</small>
  </section>
</template>

<style scoped>
.revision-review{padding:18px;margin:0 0 18px;border:1px solid #dce2eb;border-radius:8px;background:#fafbfd;color:#303846}.revision-review h2{font-size:17px;margin:0 0 10px}.revision-review h3{font-size:14px;margin:14px 0 8px}.revision-counts{font-size:13px;line-height:1.8}.revision-review details{border-top:1px solid #e3e7ee;padding:12px 0}.revision-review summary{cursor:pointer;font-size:14px;line-height:1.8}.revision-review p{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:1.8}.revision-state{display:inline-block;margin-right:8px;font-size:12px;color:#725213;background:#fff2d6;padding:1px 7px;border-radius:4px}.revision-state.resolved{color:#25664b;background:#e9f4ed}.revision-state.accepted{color:#4b5f78;background:#eaf0f7}.revision-evidence{display:block;width:100%;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0;border:0;border-left:3px solid #c6d5e8;background:#f0f4f9;padding:10px;font-size:13px;line-height:1.7;cursor:pointer}.revision-evidence small{display:block;color:#46648a}.revision-review>small{display:block;font-size:12px;line-height:1.7;color:#657287}.revision-new article{border-top:1px solid #e3e7ee;padding:4px 0}
</style>
