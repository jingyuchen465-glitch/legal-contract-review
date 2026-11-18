<script setup>
import { computed, ref, watch } from 'vue';

const props = defineProps({ batch: { type: Object, required: true } });
const showAllMethods = ref(false);
const plan = computed(() => props.batch.executionPlan);
const steps = computed(() => plan.value?.steps || []);
const previousPlan = computed(() => plan.value?.reviewId && plan.value.reviewId !== props.batch.main_review_id);
const methods = computed(() => props.batch.skills || []);
const visibleMethods = computed(() => showAllMethods.value ? methods.value : methods.value.slice(0, 3));
const documentFor = id => props.batch.documents?.find(d => d.version_id === id);
const sourceLabel = source => ({ builtin: '系统内置', experience: '法务经验', unknown: '历史记录' }[source] || '审查方法');
const toolLabels = {
  submit_review: '提交审查报告', observe_review: '复核审查结果',
  read_document: '读取合同原文', create_review_plan: '制定审查计划',
  request_information: '确认必要信息', update_task_notes: '保存审查记录',
  legal_auto_review: '多文件合同审查', 'legal-auto-review': '多文件合同审查',
  uncertain: '待核实', limitations: '审查限制',
};
function displayText(text) {
  return String(text || '').replace(/\b(?:submit_review|observe_review|read_document|create_review_plan|request_information|update_task_notes|legal_auto_review|legal-auto-review|uncertain|limitations)\b/g, name => toolLabels[name]);
}
watch([() => props.batch.id, () => props.batch.main_review_id], () => { showAllMethods.value = false; });
</script>

<template>
  <div class="review-plan-layout">
    <section class="panel review-plan-panel" aria-labelledby="review-plan-title">
      <header class="review-plan-heading">
        <div><span class="plan-eyebrow">本次如何审查</span><h2 id="review-plan-title">审查计划</h2></div>
        <span class="plan-count">{{ previousPlan ? '上轮保留' : `${steps.length} 项核查任务` }}</span>
      </header>
      <template v-if="steps.length">
        <p v-if="previousPlan" class="previous-plan-note">本轮计划尚未生成，以下为上轮保留的审查安排。</p>
        <p class="plan-goal">{{ displayText(plan.goal) }}</p>
        <ol class="plan-task-list" aria-label="审查任务">
          <li v-for="(step,index) in steps" :key="step.id" class="plan-task">
            <span class="plan-task-number" aria-hidden="true">{{ String(index + 1).padStart(2, '0') }}</span>
            <div class="plan-task-body">
              <h3>{{ displayText(step.title) }}</h3>
              <details class="plan-task-files">
                <summary>涉及 {{ step.versionIds?.length || 0 }} 份材料</summary>
                <ul><li v-for="id in step.versionIds" :key="id"><router-link v-if="documentFor(id)?.contract_id" :to="`/contracts/${documentFor(id).contract_id}?version=${id}`" :title="documentFor(id).filename">{{ documentFor(id).filename }}<span aria-hidden="true"> ↗</span></router-link><span v-else>材料暂不可用</span></li></ul>
              </details>
            </div>
          </li>
        </ol>
        <p class="plan-footnote">以上为核查安排，实际完成情况见页面顶部的审查进度。</p>
      </template>
      <p v-else class="plan-empty">材料读取后，将在这里展示本次审查的核查安排。</p>
    </section>

    <section class="panel review-method-panel" aria-labelledby="review-method-title">
      <header class="review-plan-heading"><div><span class="plan-eyebrow">审查参考</span><h2 id="review-method-title">本次审查方法</h2></div><span class="plan-count">{{ methods.length }} 项已加载</span></header>
      <ul v-if="methods.length" class="review-method-list">
        <li v-for="method in visibleMethods" :key="method.name" class="review-method">
          <span class="method-book" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M4 4.5h6a3 3 0 0 1 2 1 3 3 0 0 1 2-1h6v15h-6a3 3 0 0 0-2 1 3 3 0 0 0-2-1H4zM12 6v14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg></span>
          <div><span class="method-source">{{ sourceLabel(method.source) }}</span><h3>{{ method.title }}</h3><p :title="method.description">{{ method.description }}</p></div>
        </li>
      </ul>
      <p v-else class="plan-empty">尚未加载审查方法，后续会显示具体名称。</p>
      <button v-if="methods.length > 3" class="method-expand" type="button" :aria-expanded="showAllMethods" @click="showAllMethods = !showAllMethods">{{ showAllMethods ? '收起方法列表' : `查看全部 ${methods.length} 项方法` }}<span aria-hidden="true">{{ showAllMethods ? '↑' : '↓' }}</span></button>
    </section>
  </div>
</template>

<style scoped>
.review-plan-layout{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(280px,1fr);gap:18px;align-items:start}.review-plan-panel,.review-method-panel{min-width:0;overflow:hidden}.review-plan-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:22px 24px 18px;border-bottom:1px solid #edf0f4}.plan-eyebrow{display:block;font-size:11px;font-weight:500;letter-spacing:.04em;color:#64748b;margin-bottom:5px}.review-plan-heading h2{margin:0;font-size:18px;line-height:1.5;font-weight:650;color:#182230}.plan-count{flex-shrink:0;white-space:nowrap;border:1px solid #e2e8f0;border-radius:20px;padding:4px 10px;background:#f8fafc;font-size:12px;line-height:1.5;color:#475569}.plan-goal{margin:18px 24px 8px;padding:12px 14px;border-left:3px solid #93b8f4;background:#f7faff;color:#475569;font-size:13px;line-height:1.9;overflow-wrap:anywhere}.plan-task-list{list-style:none;padding:0 24px;margin:0}.plan-task{display:grid;grid-template-columns:30px minmax(0,1fr);gap:14px;padding:18px 0;border-bottom:1px solid #edf0f4}.plan-task:last-child{border-bottom:0}.plan-task-number{display:grid;place-items:center;width:30px;height:30px;margin-top:1px;border-radius:8px;background:#f0f5fd;color:#416ba2;font-size:12px;font-weight:650;font-variant-numeric:tabular-nums}.plan-task h3{font-size:14px;line-height:1.85;font-weight:550;color:#243447;margin:0;overflow-wrap:anywhere}.plan-task-body{min-width:0}.plan-task-files{margin-top:7px}.plan-task-files summary{color:#64748b;font-size:12px;cursor:pointer;line-height:1.8;min-height:26px;width:fit-content;max-width:100%}.plan-task-files[open] summary{color:#2563eb}.plan-task-files ul{list-style:none;margin:6px 0 0;padding:8px 12px;background:#f8fafc;border:1px solid #e7edf5;border-radius:6px}.plan-task-files li{margin:4px 0;line-height:1.8;font-size:12px;overflow-wrap:anywhere}.plan-task-files a{color:#2563eb;text-decoration:none}.plan-task-files a:hover{text-decoration:underline}.plan-footnote{margin:0;padding:12px 24px 18px;font-size:12px;line-height:1.8;color:#64748b;border-top:1px solid #edf0f4;background:#fcfdff}.previous-plan-note{margin:18px 24px 0;font-size:13px;line-height:1.8;color:#805c22}.plan-empty{padding:24px;margin:0;font-size:14px;line-height:1.8;color:#64748b}.review-method-list{list-style:none;margin:0;padding:0 22px}.review-method{display:grid;grid-template-columns:34px minmax(0,1fr);gap:12px;padding:18px 0;border-bottom:1px solid #edf0f4}.review-method:last-child{border-bottom:0}.method-book{display:grid;place-items:center;width:34px;height:34px;border:1px solid #e0e8f2;border-radius:8px;color:#55789f;background:#f6f9fd}.method-book svg{width:20px;height:20px}.method-source{display:block;margin:0 0 5px;color:#64748b;font-size:11px;line-height:1.5}.review-method h3{margin:0;color:#243447;font-size:14px;font-weight:550;line-height:1.7;overflow-wrap:anywhere}.review-method p{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;margin:6px 0 0;color:#64748b;font-size:12px;line-height:1.8;overflow-wrap:anywhere}.method-expand{display:flex;align-items:center;justify-content:center;gap:10px;width:calc(100% - 44px);margin:0 22px 20px;min-height:40px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:7px;color:#2563eb;font-size:13px;cursor:pointer}.method-expand:hover{background:#eff6ff;border-color:#bfdbfe}.method-expand:focus-visible,.plan-task-files summary:focus-visible{outline:2px solid #3b82f6;outline-offset:3px}
@media(max-width:1100px){.review-plan-layout{grid-template-columns:minmax(0,1.35fr) minmax(250px,1fr)}.review-plan-heading{padding:18px;gap:10px}.plan-task-list{padding:0 18px}.plan-goal{margin:16px 18px 6px}.review-method-list{padding:0 18px}.method-expand{margin-left:18px;width:calc(100% - 36px)}}
@media(max-width:850px){.review-plan-layout{grid-template-columns:1fr}.review-plan-heading{padding:18px 20px}.plan-task-list{padding:0 20px}.plan-goal{margin:16px 20px 6px}.plan-task{padding:16px 0}.plan-footnote{padding:12px 20px 16px}}
@media(max-width:520px){.review-plan-heading{padding:16px;gap:8px}.review-plan-heading h2{font-size:17px}.plan-count{font-size:11px;padding:4px 8px}.plan-goal{margin:14px 16px 4px;padding:10px 12px;font-size:13px}.plan-task-list{padding:0 16px}.plan-task{gap:10px;grid-template-columns:28px minmax(0,1fr)}.plan-task-number{width:28px;height:28px}.plan-task h3{font-size:14px;line-height:1.9}.plan-task-files summary{min-height:36px;display:list-item;padding-top:5px}.plan-footnote{padding:12px 16px 16px}.review-method-list{padding:0 16px}.review-method{gap:10px}.method-expand{margin:0 16px 16px;width:calc(100% - 32px);min-height:44px}.plan-empty{padding:20px 16px}.previous-plan-note{margin:16px 16px 0}}
</style>
