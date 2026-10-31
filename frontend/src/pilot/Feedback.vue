<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus/es/components/message/index.mjs';
import { api, label, time } from './api';
import './feedback.css';
const router = useRouter(), route = useRoute();
const feedback = ref([]), cases = ref([]), runs = ref([]), rules = ref([]), catalog = ref([]), tags = ref([]);
const tab = ref(route.query.tab === 'evaluation' ? 'evaluation' : 'feedback'), busy = ref(false), loading = ref(true), error = ref('');
const split = ref('development'), adapters = ref(['llm']), includeReview = ref(true), draftId = ref(String(route.query.draft || '')), selected = ref(null), details = ref(null);
const showChoice = ref(false), choice = ref({ feedback: null, operation: '', packId: '', typeId: '' });
const showSample = ref(false), sampleSource = ref(null), sample = ref(null), sampleRules = ref([]), confirmed = ref(false), sampleError = ref('');
const kindNames = { rule: '规则调整建议', false_positive: '误报案例', false_negative: '漏报案例', normal_expression: '正常表达', classification: '分类纠错' };
const types = computed(() => catalog.value.flatMap(c => c.types));
const published = computed(() => rules.value.filter(p => p.state === 'published'));
const draftPacks = computed(() => rules.value.filter(p => p.state === 'draft'));
const allRules = computed(() => [...new Map(rules.value.flatMap(p => p.rules.map(r => [r.id, r]))).values()]);
const feedbackState = f => f.state === 'retired' ? '已停用' : f.state === 'published' ? '已发布' : f.draft_rule_version_id || f.draft_classification_version_id ? '已生成草稿' : '待处理';
const typeName = id => types.value.find(t => t.id === id)?.name || id;
async function load(quiet = false) {
  const [f, c, e, p, cat] = await Promise.all([api('/feedback-cases', { quiet }), api('/evaluation-cases', { quiet }), api('/evaluations', { quiet }), api('/rule-packs', { quiet }), api('/catalog', { quiet })]);
  feedback.value = f; cases.value = c; runs.value = e; rules.value = p; catalog.value = cat.categories; tags.value = cat.tags;
}
async function perform(fn) { if (busy.value) return; busy.value = true; error.value = ''; try { await fn(); } catch (e) { error.value = e.message; } finally { busy.value = false; } }
async function edit(f, operation, input = {}) {
  await perform(async () => {
    if(operation === 'classification' && !input.typeId && !f.draft_classification_version_id) {
      choice.value = { feedback: f, operation, typeId: '', packId: '' }; showChoice.value = true; return;
    }
    const endpoint = { rule: 'rule-draft', knowledge: 'knowledge-draft', classification: 'classification-draft' }[operation];
    try {
      const result = await api(`/feedback-cases/${f.id}/${endpoint}`, { method: 'POST', body: input, quiet: true });
      showChoice.value = false;
      await router.push({ path: '/rules', query: operation === 'classification' ? { classificationDraft: result.draft.id, feedback: f.id } : { draft: result.draft.id, feedback: f.id, rule: result.ruleId } });
    } catch(e) {
      if(e.code === 'RULE_SELECTION_REQUIRED' || e.code === 'RULE_SOURCE_NOT_FOUND') {
        choice.value = { feedback: f, operation, packId: '', typeId: '' }; showChoice.value = true;
      } else throw e;
    }
  });
}
async function confirmChoice() { const c = choice.value; await edit(c.feedback, c.operation, c.operation === 'classification' ? { typeId: c.typeId } : { packId: c.packId }); }
async function retire(f) { await perform(async () => { await api(`/feedback-cases/${f.id}`, { method: 'PATCH', body: { state: 'retired', revision: f.revision } }); await load(); }); }
async function viewSource(f) { await perform(async () => { details.value = await api(`/feedback-cases/${f.id}/context`); }); }
async function evaluate() { await perform(async () => { await api('/evaluations', { method: 'POST', body: { split: split.value, adapters: adapters.value, includeReview: includeReview.value, ...(draftId.value ? { draftRuleVersionId: draftId.value } : {}) } }); ElMessage.success('评测已加入队列'); await load(); }); }
function newSample() {
  sampleSource.value = null; sampleRules.value = allRules.value; confirmed.value = false; sampleError.value = '';
  sample.value = { name: '', split: 'development', text: '', document: { blocks: [] }, expected: { typeId: '', tags: [], riskRuleIds: [], highRiskRuleIds: [], background: { ourEntity: '', perspective: '', purpose: '' } } }; showSample.value = true;
}
async function sampleFromFeedback(f) { await perform(async () => {
  const preview = await api(`/feedback-cases/${f.id}/evaluation-preview`);
  sampleSource.value = preview.source; sampleRules.value = preview.rules; sample.value = { ...preview, text: preview.document.blocks.map(b => b.text).join('\n\n') };
  confirmed.value = false; sampleError.value = ''; showSample.value = true;
}); }
function toggleRisk(id, enabled) { if(enabled) { if(!sample.value.expected.riskRuleIds.includes(id)) sample.value.expected.riskRuleIds.push(id); } else { sample.value.expected.riskRuleIds = sample.value.expected.riskRuleIds.filter(r => r!==id); sample.value.expected.highRiskRuleIds = sample.value.expected.highRiskRuleIds.filter(r => r!==id); } }
async function saveSample() {
  if(busy.value)return;busy.value=true;sampleError.value='';
  try {
    const value = sample.value;
    const body = { name: value.name, split: value.split, expected: value.expected, confirmed: confirmed.value };
    if(sampleSource.value) await api(`/feedback-cases/${sampleSource.value.feedback.id}/evaluation-case`, { method: 'POST', body, quiet: true });
    else await api('/evaluation-cases', { method: 'POST', body: { ...body, document: { blocks: value.text.split(/\n\s*\n/).map((text, i) => ({ id: `b${i+1}`, text: text.trim() })).filter(b => b.text) } }, quiet: true });
    showSample.value=false;ElMessage.success('法务标注样本已保存');await load();
  } catch(e){sampleError.value=e.message;}finally{busy.value=false;}
}
let timer;
onMounted(async () => {
  try { await load();
    const f=feedback.value.find(f=>f.id===route.query.feedback);
    if(f && route.query.edit) await edit(f, f.kind==='classification'?'classification':'rule');
    else if(f) await viewSource(f);
  } catch(e){error.value=e.message;}finally{loading.value=false;}
  timer=setInterval(()=>{if(!busy.value)load(true).catch(()=>{});},8000);
});
onUnmounted(()=>clearInterval(timer));
</script>

<template>
  <section class="page-heading"><div><div class="eyebrow">人工反馈 · 持续改进</div><h1>反馈与评测中心</h1><p>记录法务判断，完善公司标准，再用独立样本验证效果。</p></div><button class="primary" @click="newSample">＋ 添加标注样本</button></section>
  <div class="feedback-guide"><b>让下一次审核更准确</b><span>提交反馈 → 修改草稿 → 确认发布 → 检查效果</span><small>反馈本身不会改变正式规则</small></div>
  <div class="tabs"><button @click="tab='feedback'" :class="{active:tab==='feedback'}">人工反馈 {{ feedback.length }}</button><button @click="tab='evaluation'" :class="{active:tab==='evaluation'}">样本与评测 {{ cases.length }}</button></div>
  <p v-if="error" class="notice danger" role="alert">{{ error }}</p><p v-if="loading" role="status">正在加载反馈与评测…</p>
  <section v-else-if="tab==='feedback'" class="panel"><div class="panel-heading"><h2>待改进的审核案例</h2><span class="muted">同一账号即可完成反馈、修改与发布</span></div>
    <article v-for="f in feedback" :key="f.id" class="feedback-item"><div><span class="badge">{{ kindNames[f.kind]||f.kind }}</span><span class="badge" :class="f.state">{{ feedbackState(f) }}</span><small>{{ time(f.created_at) }}</small></div><p class="prewrap">{{ f.content }}</p>
      <div class="action-row"><button @click="viewSource(f)" :disabled="busy">查看来源</button><template v-if="f.state!=='retired'">
        <button v-if="['rule','false_positive','false_negative'].includes(f.kind)" class="primary" @click="edit(f,'rule')" :disabled="busy">{{ f.draft_rule_version_id&&f.state!=='published'?'继续修改规则':'按反馈修改规则' }}</button>
        <button v-if="f.kind==='classification'" class="primary" @click="edit(f,'classification')" :disabled="busy">修改分类标准</button>
        <button v-if="f.kind==='normal_expression'" class="primary" @click="edit(f,'knowledge')" :disabled="busy">加入规则参考资料</button>
        <button @click="sampleFromFeedback(f)" :disabled="busy">保存为评测样本</button><button class="text-btn" @click="retire(f)" :disabled="busy">停用反馈</button>
      </template></div>
    </article><div v-if="!feedback.length" class="empty-state"><span class="empty-icon">◉</span><h3>等待第一条人工反馈</h3><p>打开合同审核详情，选择检查项后点击「沉淀反馈案例」。</p></div>
  </section>
  <template v-else-if="!loading">
    <div class="notice">规则调试集用于改进标准；独立验收集保留给最终验证。缺少高风险正例或样本执行失败时，不能据此宣告验收通过。</div>
    <form class="panel evaluation-controls" @submit.prevent="evaluate"><label>样本集<select v-model="split" @change="split==='holdout' && (draftId='')" aria-label="样本集"><option value="development">规则调试集</option><option value="holdout">独立验收集</option></select></label>
      <label>审查版本<select v-model="draftId" :disabled="split==='holdout'" aria-label="审查版本"><option value="">当前正式规则</option><option v-for="p in draftPacks" :key="p.id" :value="p.id">{{ p.name }} · 草稿 v{{ p.version_no }}</option></select></label>
      <label class="inline-check"><input type="checkbox" value="llm" v-model="adapters" />大模型分类</label><label class="inline-check"><input type="checkbox" value="jev" v-model="adapters" />Jev 对比</label><label class="inline-check"><input type="checkbox" v-model="includeReview" />包含风险审查</label><button class="primary" :disabled="busy||!adapters.length">运行评测</button>
    </form>
    <section class="panel"><div class="panel-heading"><h2>评测记录</h2></div><div class="table-scroll"><table><thead><tr><th>创建时间</th><th>样本集 / 版本</th><th>分类方式</th><th>状态</th><th></th></tr></thead><tbody><tr v-for="r in runs" :key="r.id"><td>{{ time(r.created_at) }}</td><td>{{ r.config.split==='development'?'规则调试集':'独立验收集' }}<small>{{ r.config.draftRuleVersionId?'规则草稿':'正式规则' }}</small></td><td>{{ r.config.adapters.join(' / ') }}</td><td>{{ r.status==='completed'?'评测完成':label(r.status) }}</td><td><button @click="selected=r">查看指标与样本结果</button></td></tr></tbody></table></div><div v-if="!runs.length" class="empty-state compact">暂无评测记录</div></section>
    <section class="panel"><div class="panel-heading"><h2>法务标注样本</h2></div><table><thead><tr><th>名称</th><th>数据集</th><th>正确类型</th><th>高风险正例</th></tr></thead><tbody><tr v-for="c in cases" :key="c.id"><td>{{ c.name }}</td><td>{{ c.split==='development'?'规则调试集':'独立验收集' }}</td><td>{{ typeName(c.expected.typeId) }}</td><td>{{ c.expected.highRiskRuleIds.length }}</td></tr></tbody></table><div v-if="!cases.length" class="empty-state compact">尚未添加标注样本</div></section>
  </template>
  <el-dialog v-model="showChoice" :title="choice.operation==='classification'?'选择正确合同类型':'选择要修改的规则包'" width="560px" :close-on-click-modal="false">
    <form class="stack" @submit.prevent="confirmChoice">
      <template v-if="choice.operation==='classification'">
        <p class="notice">明确正确类型后，系统将创建该类型的分类指导草稿。</p>
        <label>正确合同类型<select v-model="choice.typeId" required><option value="">请选择</option><option v-for="t in types" :key="t.id" :value="t.id">{{ t.name }}</option></select></label>
      </template>
      <template v-else-if="published.length">
        <p class="notice">当前反馈无法唯一关联到生效规则，请人工选择目标规则包。没有对应检查项时会补充新检查项，请核实后保存。</p>
        <label>正式规则包<select v-model="choice.packId" required><option value="">请选择</option><option v-for="p in published" :key="p.id" :value="p.pack_id">{{ p.name }} · v{{ p.version_no }}</option></select></label>
      </template>
      <div v-else class="notice">
        <b>反馈已保存，尚无正式规则可供修改。</b>
        <p>请先在「分类与规则中心」核实规则草稿，提交审核并发布，再回到本反馈点击「按反馈修改规则」。</p>
        <router-link to="/rules">前往分类与规则中心 →</router-link>
      </div>
      <p v-if="error" role="alert" class="error-text">{{ error }}</p>
      <button v-if="choice.operation==='classification'||published.length" class="primary" :disabled="busy">创建并打开草稿</button>
    </form>
  </el-dialog>
  <el-dialog :model-value="!!details" title="反馈来源与处理记录" width="700px" @close="details=null"><div v-if="details" class="stack"><p><router-link :to="`/contracts/${details.contract.id}`">{{ details.contract.title }}</router-link> · 文件 v{{ details.version.version_no }}<br>提交人：{{ details.submittedBy }} · {{ time(details.feedback.created_at) }}</p><blockquote v-for="(e,i) in details.finding?.evidence||[]" :key="i">{{ e.quote }}</blockquote><p class="prewrap">{{ details.feedback.content }}</p><p v-if="details.finding?.disposition">法务复核：{{ label(details.finding.disposition.action) }} · {{ details.finding.disposition.reason }}</p><p>状态：{{ feedbackState(details.feedback) }}</p><router-link v-if="details.feedback.rule_version_id||details.feedback.draft_rule_version_id" :to="{path:'/rules',query:{draft:details.feedback.draft_rule_version_id,feedback:details.feedback.id}}">查看关联规则版本 →</router-link></div></el-dialog>
  <el-dialog v-model="showSample" title="确认法务标注样本" width="850px" :close-on-click-modal="false"><form v-if="sample" class="stack sample-form" @submit.prevent="saveSample"><p class="notice">{{ sampleSource?'已带入来源合同和法务复核结果。请核实标准答案；人工新增风险需要先转为正式规则，才可作为风险正例。':'填写合同原文及法务确认的标准答案，无需填写技术编号。' }}</p><p v-if="sampleSource?.requiresConfirmation" class="notice danger">来源审核仍有未处理项，请逐项核实下方预期风险。</p><label>样本名称<input v-model="sample.name" required maxlength="200" /></label><div class="sample-columns"><label>数据集<select v-model="sample.split"><option value="development">规则调试集</option><option value="holdout">独立验收集</option></select></label><label>正确合同类型<select v-model="sample.expected.typeId" required><option value="">请选择</option><option v-for="t in types" :key="t.id" :value="t.id">{{ t.name }}</option></select></label></div><label>合同原文<textarea v-model="sample.text" :readonly="!!sampleSource" required rows="6" /></label><fieldset><legend>专项标签</legend><div class="tag-options"><label v-for="t in tags" :key="t" class="inline-check"><input type="checkbox" v-model="sample.expected.tags" :value="t" />{{ t }}</label></div></fieldset><fieldset><legend>应当检出的风险</legend><div v-if="!sampleRules.length" class="notice">尚无审查规则，可先保存仅用于分类的样本。</div><div v-for="r in sampleRules" :key="r.id" class="sample-risk"><label class="inline-check"><input type="checkbox" :checked="sample.expected.riskRuleIds.includes(r.id)" @change="toggleRisk(r.id,$event.target.checked)" />{{ r.title }}</label><label class="inline-check"><input type="checkbox" v-model="sample.expected.highRiskRuleIds" :value="r.id" :disabled="!sample.expected.riskRuleIds.includes(r.id)" />高风险</label></div></fieldset><div class="sample-columns"><label>我方主体<input v-model="sample.expected.background.ourEntity" required /></label><label>我方立场<input v-model="sample.expected.background.perspective" required /></label></div><label>交易目的<textarea v-model="sample.expected.background.purpose" required rows="2" /></label><label class="inline-check"><input type="checkbox" v-model="confirmed" required />我已核实合同分类和预期风险，确认以上内容可作为标准答案</label><p v-if="sampleError" role="alert" class="error-text">{{ sampleError }}</p><div class="dialog-actions"><button type="button" @click="showSample=false" :disabled="busy">取消</button><button class="primary" :disabled="busy||!confirmed">保存标注样本</button></div></form></el-dialog>
  <el-dialog :model-value="!!selected" title="评测结果" width="850px" @close="selected=null"><div v-for="(a,key) in selected?.result?.adapters" :key="key" class="metrics-result"><h3>{{ key }}</h3><div class="stat-grid"><div v-for="k in ['classificationAccuracy','highRiskRecall','precision']" :key="k" class="stat-card"><span>{{ {classificationAccuracy:'分类正确率',highRiskRecall:'高风险召回率',precision:'精确率'}[k] }}</span><strong>{{ a.metrics[k]===null?'不可评估':(a.metrics[k]*100).toFixed(1)+'%' }}</strong></div></div><p class="notice">{{ a.metrics.acceptance }} · {{ a.metrics.evaluable?'指标可计算':'缺少正例、预测或完整结果，不能宣告通过' }}</p></div><p v-if="selected?.result?.message" role="alert" class="notice danger">{{ selected.result.message }}</p><details><summary>逐样本结果与版本快照</summary><pre class="json-view">{{ JSON.stringify(selected?.result,null,2) }}</pre></details></el-dialog>
</template>
