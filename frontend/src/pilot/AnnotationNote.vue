<script setup>
import { annotationText, annotationSeverity } from './annotations.mjs';
defineProps({ finding: Object, color: Boolean, active: Boolean, editable: Boolean, busy: Boolean, number: Number });
defineEmits(['select', 'review', 'correct', 'adopt', 'reject']);
const states = { accept: '已认可意见', correct: '已修正建议', needs_information: '待补充信息', acknowledge: '已记录意见' };
</script>

<template>
  <article class="inline-note" :class="[annotationSeverity(finding), { 'color-note': color, 'note-active': active }]" :data-finding-id="finding.id">
    <button type="button" class="note-heading" :aria-pressed="active" @click="$emit('select', finding.id)"><span class="note-number">{{ String(number || 1).padStart(2, '0') }}</span><b>{{ finding.title }}</b><small>{{ states[finding.disposition?.action] || '待复核' }}</small></button>
    <div class="note-suggestion"><strong>{{ finding.disposition?.action === 'correct' ? '法务修正建议' : '修改建议' }}</strong><p>{{ annotationText(finding) || '暂无修改建议，请补充处理意见。' }}</p></div>
    <details v-if="finding.relatedFindings?.length>1" class="note-explanation"><summary>已合并 {{ finding.relatedFindings.length }} 个检查项的相同意见</summary><p>{{ finding.relatedFindings.map(f=>f.title).join('；') }}。认可、修正或驳回将同时处理这些相同意见。</p></details>
    <details class="note-explanation"><summary>查看问题说明</summary><p>{{ finding.reason }}</p><p v-if="finding.disposition?.reason">法务意见：{{ finding.disposition.reason }}</p></details>
    <div class="note-actions">
      <template v-if="editable"><button v-if="!finding.disposition || finding.disposition.action === 'needs_information'" type="button" class="note-adopt" title="仅记录认可这条审查意见，不会修改合同正文" :disabled="busy" @click="$emit('adopt', finding.id)">认可意见</button><button type="button" :disabled="busy" @click="$emit('correct', finding.id)">修正建议</button><button type="button" :disabled="busy" @click="$emit('reject', finding.id)">驳回</button></template>
      <button type="button" class="note-detail" @click="$emit('review', finding.id)">依据与详情 ↗</button>
    </div>
  </article>
</template>
