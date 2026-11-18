<script setup>
import { computed, ref, watch } from 'vue';
const props = defineProps({ question: { type: Object, required: true }, busy: Boolean });
const emit = defineEmits(['answer']);
const page = ref(0), draft = ref({}), supplement = ref('');
const questions = computed(() => props.question.data?.questions || []);
const current = computed(() => questions.value[page.value]);
const answer = computed(() => draft.value[current.value?.id]);
function answered(q) {
  const a = draft.value[q.id];
  return !!a && (a.other ? !!a.custom.trim() : !!a.selected.length);
}
const complete = computed(() => questions.value.length > 0 && questions.value.every(answered));
watch(() => props.question.id, () => {
  page.value = 0; supplement.value = '';
  draft.value = Object.fromEntries(questions.value.map(q => [q.id, { selected: [], custom: '', other: !q.options?.length }]));
}, { immediate: true });
function select(label) {
  if (props.busy) return;
  const a = answer.value;
  if (current.value.multiSelect) {
    a.selected = a.selected.includes(label) ? a.selected.filter(v => v !== label) : [...a.selected, label];
  } else {
    a.selected = [label]; a.other = false; a.custom = '';
  }
}
function selectOther() {
  if (props.busy) return;
  answer.value.other = !answer.value.other;
  if (!current.value.multiSelect) answer.value.selected = [];
  if (!answer.value.other) answer.value.custom = '';
}
function submit() {
  if (!complete.value || props.busy) return;
  emit('answer', {
    questionId: props.question.id,
    answers: questions.value.map(q => {
      const a = draft.value[q.id];
      return { id: q.id, selected: a.selected, ...(a.other && a.custom.trim() ? { custom: a.custom.trim() } : {}) };
    }),
    content: supplement.value.trim(),
  });
}
</script>

<template>
  <form v-if="current && answer" class="agent-question-card" aria-label="补充审查信息" @submit.prevent="submit">
    <header><span class="question-card-icon" aria-hidden="true">?</span><div><b>需要你确认</b><span>补充必要信息后，Agent 将继续审查</span></div><small>{{ page + 1 }} / {{ questions.length }}</small></header>
    <div v-if="questions.length > 1" class="question-card-steps" aria-label="问题列表"><button v-for="(q, index) in questions" :key="q.id" type="button" :class="{ active: page === index, done: answered(q) }" :aria-current="page === index ? 'step' : undefined" :disabled="busy" @click="page = index"><span>{{ answered(q) ? '✓' : index + 1 }}</span>{{ q.header || '问题 ' + (index + 1) }}</button></div>
    <fieldset :disabled="busy" :key="current.id"><legend>{{ current.question }}</legend><p v-if="current.detail" class="question-card-detail">{{ current.detail }}</p><span class="question-card-type">{{ current.multiSelect ? '可选择多项' : '请选择一项' }}</span>
      <div class="question-card-options" :role="current.multiSelect ? 'group' : 'radiogroup'" :aria-label="current.question">
        <label v-for="(option, index) in current.options || []" :key="option.label" class="question-card-option" :class="{ selected: answer.selected.includes(option.label) }"><input :type="current.multiSelect ? 'checkbox' : 'radio'" :name="'answer-' + current.id" :checked="answer.selected.includes(option.label)" :value="option.label" @change="select(option.label)" /><span class="question-option-number" aria-hidden="true">{{ index + 1 }}</span><span class="question-option-text"><b>{{ option.label }}</b><small v-if="option.description">{{ option.description }}</small></span></label>
        <label v-if="current.options?.length" class="question-card-option" :class="{ selected: answer.other }"><input :type="current.multiSelect ? 'checkbox' : 'radio'" :name="'answer-' + current.id" :checked="answer.other" value="__custom__" @change="selectOther" /><span class="question-option-number" aria-hidden="true">✎</span><span class="question-option-text"><b>其他，自行填写</b></span></label>
      </div>
      <label v-if="answer.other" class="question-card-custom">{{ current.options?.length ? '其他回答' : '你的回答' }}<textarea v-model="answer.custom" rows="2" maxlength="3000" :placeholder="current.options?.length ? '填写更符合实际情况的回答…' : '请补充你了解的信息…'" /></label>
    </fieldset>
    <label v-if="page === questions.length - 1" class="question-card-supplement">补充说明 <span>（选填）</span><textarea v-model="supplement" rows="2" maxlength="3000" :disabled="busy" placeholder="还有需要 Agent 了解的背景，可以补充在这里…" /></label>
    <footer><button v-if="page > 0" type="button" class="question-card-back" :disabled="busy" @click="page--">← 上一题</button><span v-else class="question-card-footnote">选择后确认提交</span><button v-if="page < questions.length - 1" type="button" class="question-card-submit" :disabled="busy || !answered(current)" @click="page++">下一题 →</button><button v-else class="question-card-submit" type="submit" :disabled="busy || !complete">{{ busy ? '提交中…' : '确认并继续' }}<span aria-hidden="true">↑</span></button></footer>
  </form>
</template>

<style scoped>
.agent-question-card{margin:12px 18px 16px;padding:17px;background:#fff;border:1px solid #d8e5f5;border-radius:12px;box-shadow:0 3px 14px #1e4f8310;min-width:0}
.agent-question-card header{display:flex;align-items:center;gap:10px;margin-bottom:16px}
.question-card-icon{display:grid;place-items:center;flex:none;width:31px;height:31px;border-radius:9px;background:#eaf3ff;color:#1976d2;font-size:16px;font-weight:600}
.agent-question-card header>div{display:flex;flex-direction:column;gap:4px;min-width:0}.agent-question-card header b{font-size:13px;color:#2b3a4e}.agent-question-card header div>span{font-size:10px;color:#8c95a1}
.agent-question-card header>small{margin-left:auto;color:#a1a9b4;white-space:nowrap;font-size:11px}
.question-card-steps{display:flex;gap:6px;margin-bottom:18px;overflow-x:auto;padding-bottom:3px}
.question-card-steps button{display:flex;align-items:center;gap:5px;flex:none;padding:5px 8px;border:1px solid transparent;border-radius:6px;background:#f5f7fa;color:#8b95a3;font-size:10px}
.question-card-steps button.active{border-color:#d4e4f9;background:#eaf3ff;color:#1976d2}.question-card-steps button.done{color:#1976d2}
.question-card-steps button>span{display:grid;place-items:center;width:14px;height:14px;border-radius:50%;background:#fff;font-size:9px}
.agent-question-card fieldset{padding:0;margin:0;min-width:0;border:0}.agent-question-card legend{padding:0;font-size:13px;font-weight:600;line-height:1.75;color:#29394c;overflow-wrap:anywhere}
.question-card-detail{margin:7px 0 0;color:#8390a0;font-size:11px;line-height:1.7;white-space:pre-wrap}
.question-card-type{display:block;margin:7px 0 10px;color:#9aa3af;font-size:10px}
.question-card-options{display:flex;flex-direction:column;gap:7px}
.question-card-option{display:flex;flex-direction:row;align-items:center;gap:9px;padding:11px 12px;position:relative;border:1px solid #e5e9ef;border-radius:8px;cursor:pointer;background:#fff;transition:background .15s,border-color .15s}
.question-card-option:hover{background:#f7faff;border-color:#b4d0ef}.question-card-option.selected{background:#edf5ff;border-color:#1976d2}
.question-card-option input{width:14px;height:14px;flex:none;margin:0;accent-color:#1976d2}
.question-option-number{color:#a1aab7;font-size:11px}.question-card-option.selected .question-option-number{color:#1976d2}
.question-option-text{display:flex;flex-direction:column;gap:3px;min-width:0}.question-option-text b{font-size:12px;font-weight:500;color:#4c5c70;overflow-wrap:anywhere}.question-option-text small{font-size:10px;color:#8b96a5;line-height:1.6;overflow-wrap:anywhere}.selected .question-option-text b{color:#1565c0}
.question-card-custom,.question-card-supplement{display:flex;flex-direction:column;gap:7px;font-size:11px;color:#69788d;margin-top:13px}
.question-card-supplement>span{display:contents;color:#9aa4b1}.agent-question-card textarea{width:100%;min-height:58px;padding:9px 10px;border:1px solid #dce3ed;border-radius:7px;font-size:12px;line-height:1.7;resize:vertical}.agent-question-card textarea::placeholder{color:#a2aab5}
.agent-question-card footer{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:17px;padding:0;color:#9aa4b0}
.question-card-footnote{font-size:10px}.question-card-back{padding:7px 0;border:0;background:transparent;color:#718197;font-size:11px}
.question-card-submit{display:flex;align-items:center;justify-content:center;gap:12px;min-height:34px;padding:7px 13px;border:1px solid #1976d2;border-radius:7px;background:#1976d2;color:white;font-size:12px}.question-card-submit:hover{background:#1565c0;border-color:#1565c0}.question-card-submit:disabled{color:#a2afbf;border-color:#eaf0f7;background:#eaf0f7;opacity:1}.question-card-submit>span{font-size:17px;line-height:1}
@media(max-width:520px){.agent-question-card{margin:10px;padding:13px}.question-card-option{padding:10px 9px;gap:7px}.agent-question-card header div>span{font-size:9px}.question-card-steps{gap:4px}.question-card-steps button{padding:5px 6px}}
</style>
