<script setup>
import { ref, computed, onMounted, onBeforeUnmount, toRaw, nextTick } from 'vue';
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus/es/components/message/index.mjs';
import { api, role, label, time } from './api';
import { scopeLabels, editPack, newRule, newKnowledge, validatePack, scopeText } from './rule-form.mjs';
import RuleTags from './RuleTags.vue';
import './rules.css';

const route = useRoute(), router = useRouter();
let routeOpened = false;
const catalog = ref([]), packs = ref([]), guidance = ref([]), loading = ref(true), loadError = ref(''), busy = ref(false), feedbackContext = ref(null), targetRuleId = ref('');
const search = ref(''), stateFilter = ref(''), showHistory = ref(false), show = ref(false), selected = ref(null), action = ref(null);
const form = ref(editPack()), packId = ref(''), baseline = ref(''), source = ref(null), errors = ref([]), discard = ref(false), errorBox = ref(null), editor = ref(null);
const classificationShow = ref(false), classificationDraft = ref(null), classificationForm = ref({ description: '', include: [], exclude: [], examples: [] }), classificationBusy = ref(false);
const classificationBaseline = ref(''), classificationPublishConfirm = ref(false), classificationSource = ref(null);
const classificationDirty = computed(() => classificationShow.value && JSON.stringify(classificationForm.value) !== classificationBaseline.value);
const dirty = computed(() => show.value && JSON.stringify(form.value) !== baseline.value);
const latest = computed(() => { const map = new Map(); for (const p of packs.value) if (!map.has(p.pack_id) || Number(p.version_no) > Number(map.get(p.pack_id).version_no)) map.set(p.pack_id, p); return [...map.values()]; });
const filtered = computed(() => (showHistory.value ? packs.value : latest.value).filter(p => (!stateFilter.value || p.state === stateFilter.value) && `${p.name} ${scopeText(p.scope, catalog.value)}`.toLowerCase().includes(search.value.toLowerCase())));
const publishedCount = computed(() => packs.value.filter(p => p.state === 'published').length);
const enabledCount = computed(() => catalog.value.flatMap(c => c.types).filter(t => t.reviewEnabled).length);
const actionTitle = computed(() => ({ submit: '提交规则审核', publish: '确认发布规则', retire: '确认停用规则' }[action.value?.kind] || ''));
function liveVersion(p) { return packs.value.find(v => v.pack_id === p.pack_id && v.state === 'published'); }
async function load() {
  loading.value = true; loadError.value = '';
  try {
    const [c, p, g] = await Promise.all([api('/catalog', { quiet: true }), api('/rule-packs', { quiet: true }), api('/classification-guidance', { quiet: true })]); catalog.value = c.categories; packs.value = p; guidance.value = g;
    if (!routeOpened && route.query.feedback) {
      const feedback = (await api('/feedback-cases', { quiet: true })).find(item => item.id === route.query.feedback);
      feedbackContext.value = feedback || null;
      targetRuleId.value = String(route.query.rule || '');
      const selectedDraft = packs.value.find(item => item.id === route.query.draft);
      if (selectedDraft?.state === 'draft') await draft(selectedDraft);
      else if (selectedDraft) selected.value = selectedDraft;
    }
    if (!routeOpened && route.query.classificationDraft) {
      const selectedGuidance = guidance.value.find(item => item.id === route.query.classificationDraft);
      if (selectedGuidance) await openClassification(selectedGuidance);
    }
    routeOpened = true;
  }
  catch (e) { loadError.value = e.message || '加载失败，请重试。'; } finally { loading.value = false; }
}
const guidanceForm = value => ({ description: value?.description || '', include: (value?.include || []).join('\n'), exclude: (value?.exclude || []).join('\n'), examples: (value?.examples || []).join('\n') });
const guidancePayload = value => ({ description: value.description.trim(), include: value.include.split(/\r?\n/).map(item => item.trim()).filter(Boolean), exclude: value.exclude.split(/\r?\n/).map(item => item.trim()).filter(Boolean), examples: value.examples.split(/\r?\n/).map(item => item.trim()).filter(Boolean) });
async function openClassification(row) { classificationDraft.value = row; classificationForm.value = guidanceForm(row.guidance); classificationBaseline.value = JSON.stringify(classificationForm.value); classificationSource.value = row.source_feedback_id ? (await api(`/feedback-cases/${row.source_feedback_id}/context`)).feedback : null; classificationShow.value = true; }
async function saveClassification() { classificationBusy.value = true; try { const editing = classificationDraft.value.id && classificationDraft.value.state === 'draft'; const result = await api(editing ? `/classification-guidance-versions/${classificationDraft.value.id}` : `/classification-guidance/${encodeURIComponent(classificationDraft.value.type_id)}/versions`, { method: editing ? 'PUT' : 'POST', body: { ...guidancePayload(classificationForm.value), revision: classificationDraft.value.revision }, quiet: true }); classificationDraft.value = result; classificationForm.value = guidanceForm(result.guidance); classificationBaseline.value = JSON.stringify(classificationForm.value); ElMessage.success(`已保存分类指导第 ${result.version_no} 版草稿`); await load(); } catch (e) { ElMessage.error(e.message); } finally { classificationBusy.value = false; } }
async function publishClassification() { if(classificationDirty.value)return; classificationBusy.value = true; try { await api(`/classification-guidance-versions/${classificationDraft.value.id}/publish`, { method: 'POST', body: { revision: classificationDraft.value.revision }, quiet: true }); classificationPublishConfirm.value = false; classificationShow.value = false; ElMessage.success('分类指导已发布，后续新预审将使用此版本'); await load(); } catch (e) { ElMessage.error(e.message); } finally { classificationBusy.value = false; } }
function closeClassification(done) { if(classificationBusy.value)return; if(classificationDirty.value&&!window.confirm('分类指导尚未保存，确定放弃修改？'))return; classificationShow.value=false;if(done)done(); }
async function draft(p) {
  feedbackContext.value = p?.source_feedback_id ? (await api(`/feedback-cases/${p.source_feedback_id}/context`)).feedback : null;
  source.value = p || null; packId.value = p?.pack_id || `pack-${crypto.randomUUID()}`;
  form.value = editPack(p ? toRaw(p) : null);
  for (const field of ['categoryIds', 'typeIds', 'tags']) form.value.scope[field] ||= [];
  baseline.value = JSON.stringify(form.value); errors.value = []; discard.value = false; show.value = true;
  nextTick(() => {
    if (!targetRuleId.value || !editor.value) return;
    const node = [...editor.value.querySelectorAll('[data-rule-id]')].find(item => item.dataset.ruleId === targetRuleId.value);
    node?.scrollIntoView({ block: 'center' });
  });
}
function closeEditor(done) { if (busy.value) return; if (dirty.value) { discard.value = true; return; } if (done) done(); else show.value = false; }
async function save() {
  errors.value = validatePack(form.value);
  if (errors.value.length) { await nextTick(); errorBox.value?.focus(); return; }
  busy.value = true;
  try {
    const editing = source.value?.state === 'draft';
    const result = await api(editing ? `/rule-pack-versions/${source.value.id}` : `/rule-packs/${encodeURIComponent(packId.value)}/versions`, { method: editing ? 'PUT' : 'POST', body: { ...form.value, revision: source.value?.revision }, quiet: true });
    show.value = false; ElMessage.success(`已保存第 ${result.version_no} 版草稿，审核发布后才会生效。`); await load();
  } catch (e) { errors.value = [e.message || '保存失败，填写内容已保留，请重试。']; await nextTick(); errorBox.value?.focus(); } finally { busy.value = false; }
}
async function transition() {
  const { pack, kind } = action.value; busy.value = true;
  try { await api(`/rule-pack-versions/${pack.id}/${kind}`, { method: 'POST', body: { revision: pack.revision }, quiet: true }); action.value = null; selected.value = null; ElMessage.success({ submit: '已提交审核。', publish: '规则已发布，后续预审将使用此版本。', retire: '规则已停用。' }[kind]); await load(); }
  catch (e) { action.value.error = e.message || '操作失败，请重试。'; } finally { busy.value = false; }
}
async function addRule() { form.value.rules.push(newRule()); await nextTick(); editor.value?.querySelector('.rule-item:last-of-type input')?.focus(); }
function jumpTo(index) { editor.value?.querySelectorAll('.rule-form-section')[index]?.scrollIntoView({ block: 'start' }); }
function removeRule(i) { if ((!form.value.rules[i].title && !form.value.rules[i].instruction) || window.confirm(`删除检查项「${form.value.rules[i].title || i + 1}」？保存新草稿后生效。`)) form.value.rules.splice(i, 1); }
function removeKnowledge(i) { const k = form.value.knowledge[i]; if (![k.title, k.content, k.source, k.effectiveDate].some(Boolean) || window.confirm(`删除参考资料「${k.title || i + 1}」？`)) form.value.knowledge.splice(i, 1); }
function beforeUnload(e) { if (dirty.value || classificationDirty.value || busy.value || classificationBusy.value) { e.preventDefault(); e.returnValue = ''; } }
onBeforeRouteLeave(() => !busy.value && !classificationBusy.value && (!(dirty.value || classificationDirty.value) || window.confirm('规则尚未保存，离开后会丢失修改。确定离开吗？')));
onMounted(() => { load(); window.addEventListener('beforeunload', beforeUnload); });
onBeforeUnmount(() => window.removeEventListener('beforeunload', beforeUnload));
</script>

<template>
  <div class="rules-page">
    <section class="page-heading"><div><div class="eyebrow">审查标准 · 由法务确认</div><h1>分类与规则中心</h1><p>告诉 AI 检查什么、怎样判断，让每份合同按公司标准预审。</p></div><button v-if="role('publisher')" class="primary" @click="draft()">＋ 新建规则包</button></section>
    <div class="rule-guide"><div><b>从一条审查标准开始</b><p>选择适用合同，写清检查要求，确认后发布。</p></div><ol><li><span>1</span>填写规则草稿</li><li><span>2</span>核对审查标准</li><li><span>3</span>发布后用于预审</li></ol></div>
    <div v-if="loadError" class="notice danger" role="alert">{{ loadError }} <button @click="load">重新加载</button></div>
    <div v-if="loading" class="notice" role="status">正在加载分类与规则…</div>
    <template v-else-if="!loadError">
      <section class="rule-catalog"><div class="rule-section-title"><h2>合同分类</h2><span>{{ enabledCount }} 类已启用正式审查 · {{ publishedCount }} 个生效规则包</span></div><div class="category-grid"><article v-for="(c, i) in catalog" :key="c.id" class="panel category-card"><span class="eyebrow">合同目录 / 0{{ i + 1 }}</span><h3>{{ c.name }}</h3><div v-for="t in c.types" :key="t.id"><span>{{ t.name }}</span><small :class="t.reviewEnabled ? 'text-green' : 'muted'">{{ t.reviewEnabled ? '正式已启用' : t.trialAvailable ? '可示例试审' : '待配置规则' }}</small></div></article></div></section>
      <section class="panel rule-library"><div class="panel-heading"><div><h2>我的审查规则 <span class="count">{{ latest.length }} 个规则包</span></h2><p>草稿可继续完善。发布只影响后续任务，历史报告保留原依据。</p></div><button class="text-btn" :disabled="busy" @click="load">刷新</button></div>
        <div class="rule-filters"><label class="rule-search">搜索规则<input v-model="search" placeholder="输入名称或合同类型" type="search" /></label><label>版本状态<select v-model="stateFilter"><option value="">全部状态</option><option v-for="s in ['draft', 'pending', 'published', 'retired']" :key="s" :value="s">{{ label(s) }}</option></select></label><label class="inline-check"><input v-model="showHistory" type="checkbox" />显示历史版本</label></div>
        <div v-if="!filtered.length" class="empty-state compact"><h3>{{ packs.length ? '没有符合条件的规则' : '还没有审查规则' }}</h3><p>{{ packs.length ? '调整搜索或状态筛选，也可以勾选历史版本查找。' : '新建一个规则包，选择合同类型并添加第一条检查项。' }}</p><button v-if="!packs.length && role('publisher')" class="primary" @click="draft()">新建规则包</button></div>
        <article v-for="p in filtered" :key="p.id" class="rule-pack-row"><div class="rule-pack-main"><div class="rule-pack-title"><h3>{{ p.name }}</h3><span class="badge" :class="p.state">{{ label(p.state) }}</span><span class="rule-version">第 {{ p.version_no }} 版</span></div><p>{{ scopeText(p.scope, catalog) }}</p><small v-if="p.source_feedback_id">来源：人工反馈 · <router-link :to="{path:'/feedback',query:{feedback:p.source_feedback_id}}">查看修改依据</router-link></small><div class="rule-pack-meta"><span>{{ p.rules.length }} 个检查项</span><span>{{ p.rules.filter(r => r.mandatory).length }} 项必检</span><span>{{ p.knowledge.length }} 份参考资料</span></div><small v-if="liveVersion(p) && p.state !== 'published'" class="text-green">当前生效：第 {{ liveVersion(p).version_no }} 版；此版本尚未替换它。</small><small v-else-if="p.state === 'published'" class="text-green">{{ time(p.published_at) }} 发布 · 用于后续预审</small><small v-else-if="!liveVersion(p)" class="muted">此规则包当前没有生效版本</small></div><div class="action-row"><button @click="selected = p">查看内容</button><template v-if="role('publisher')"><button @click="draft(p)">{{ p.state === 'draft' ? '编辑草稿' : '基于此版修改' }}</button><button v-if="p.state === 'draft'" @click="router.push({path:'/feedback',query:{draft:p.id,tab:'evaluation'}})">试评测草稿</button><button v-if="p.state === 'draft'" :disabled="busy" @click="action = { pack: p, kind: 'submit' }">提交审核</button><button v-if="p.state === 'pending'" class="primary" :disabled="busy" @click="action = { pack: p, kind: 'publish' }">审核并发布</button><button v-if="p.state === 'published'" class="text-btn" :disabled="busy" @click="action = { pack: p, kind: 'retire' }">停用</button></template></div></article>
      </section>
      <section class="panel rule-library"><div class="panel-heading"><div><h2>合同分类指导</h2><p>分类纠错反馈可以在这里补充适用边界、排除条件和示例。</p></div><select aria-label="新建分类指导" @change="if($event.target.value)openClassification({type_id:$event.target.value,guidance:{}});$event.target.value=''"><option value="">＋ 为合同类型添加指导</option><option v-for="t in catalog.flatMap(c=>c.types)" :key="t.id" :value="t.id">{{ t.name }}</option></select></div><div v-if="!guidance.length" class="empty-state compact"><p>尚未发布分类指导，分类仍使用基础合同目录。</p></div><article v-for="g in guidance" :key="g.id" class="rule-pack-row"><div class="rule-pack-main"><div class="rule-pack-title"><h3>{{ catalog.flatMap(c => c.types).find(t => t.id === g.type_id)?.name || g.type_id }}</h3><span class="badge" :class="g.state">{{ label(g.state) }}</span><span class="rule-version">第 {{ g.version_no }} 版</span></div><p>{{ g.guidance.description || '未填写分类说明' }}</p><small>创建：{{ time(g.created_at) }}<template v-if="g.published_at"> · 发布：{{ time(g.published_at) }}</template></small><router-link v-if="g.source_feedback_id" :to="{path:'/feedback',query:{feedback:g.source_feedback_id}}">查看来源反馈</router-link></div><div class="action-row"><button @click="openClassification(g)">{{ g.state === 'draft' ? '编辑草稿' : '基于此版修改' }}</button></div></article></section><div class="notice">示例规则用于体验流程，请法务按公司标准核实后发布。合同类型需要已发布的专项规则才能正式预审；通用规则和模板对照用于补充检查。</div>
    </template>
  </div>

  <el-dialog v-model="show" :title="source ? `编辑规则 · 基于第 ${source.version_no} 版` : '新建审查规则包'" width="940px" top="4vh" class="rule-editor-dialog" :before-close="closeEditor" :close-on-click-modal="false" :close-on-press-escape="!busy">
    <nav class="rule-editor-nav" aria-label="规则配置分区"><button type="button" @click="jumpTo(0)">01 基本信息</button><button type="button" @click="jumpTo(1)">02 检查项（{{ form.rules.length }}）</button><button type="button" @click="jumpTo(2)">03 参考资料（{{ form.knowledge.length }}）</button></nav>
    <form ref="editor" class="rule-editor" novalidate @submit.prevent="save">
      <div v-if="errors.length" ref="errorBox" class="notice danger" tabindex="-1" role="alert"><b>还需完善以下内容</b><ul><li v-for="e in errors" :key="e">{{ e }}</li></ul></div>
      <fieldset :disabled="busy">
        <div v-if="source" class="notice">{{ source.state === 'draft' ? '保存将更新当前草稿，正式版本保持不变。' : '保存将创建新的草稿版本，保留当前版本。' }}草稿需要提交确认、发布后才生效。</div>
        <section class="rule-form-section"><div class="rule-form-heading"><span>01</span><div><h3>基本信息</h3><p>用业务名称描述这组标准，系统自动管理编号。</p></div></div><label>规则包名称 <span class="required">必填</span><input v-model="form.name" maxlength="200" placeholder="例如：软件服务合同审查标准" /></label><label>适用方式<select v-model="form.scope.level"><option v-for="(name, key) in scopeLabels" :key="key" :value="key">{{ name }}</option></select></label>
          <div v-if="form.scope.level === 'common'" class="rule-scope-hint">所有合同都将叠加这些检查项。各类型仍需单独发布专项规则。</div>
          <fieldset v-else-if="form.scope.level === 'category'" class="rule-options"><legend>选择合同大类（可多选）</legend><label v-for="c in catalog" :key="c.id" class="inline-check"><input v-model="form.scope.categoryIds" type="checkbox" :value="c.id" />{{ c.name }}</label></fieldset>
          <fieldset v-else-if="['type', 'template'].includes(form.scope.level)" class="rule-options"><legend>选择合同类型（可多选）</legend><div v-for="c in catalog" :key="c.id" class="rule-type-group"><b>{{ c.name }}</b><div><label v-for="t in c.types" :key="t.id" class="inline-check"><input v-model="form.scope.typeIds" type="checkbox" :value="t.id" />{{ t.name }}</label></div></div><p v-if="form.scope.level === 'template'" class="muted">将模板要求写在检查项中；模板对照不能代替该类型的专项规则包。</p></fieldset>
          <div v-else><p>合同含以下任一标签时，加载这组检查项。</p><RuleTags v-model="form.scope.tags" label="适用标签" /></div>
        </section>
        <section class="rule-form-section"><div class="rule-form-heading"><span>02</span><div><h3>检查项 <small>{{ form.rules.length }} 项</small></h3><p>每项只描述一个问题，写清正常边界和信息不足时怎样处理。</p></div></div>
          <div v-if="feedbackContext" class="notice">本次规则修改来自反馈：{{ feedbackContext.content }}<br><small>保存新草稿后仍需确认发布，正式规则才会影响后续预审。</small></div>
          <article v-for="(r, i) in form.rules" :key="r.id" :data-rule-id="r.id" class="rule-item"><header><b>检查项 {{ String(i + 1).padStart(2, '0') }}</b><button type="button" class="text-btn rule-remove" :aria-label="`删除检查项 ${i + 1}`" @click="removeRule(i)">删除</button></header><div class="rule-field-grid"><label>检查项名称 <span class="required">必填</span><input v-model="r.title" maxlength="200" placeholder="例如：付款条件与验收挂钩" /></label><label>发现问题时的风险等级<select v-model="r.severity"><option value="high">高风险</option><option value="medium">中风险</option><option value="low">低风险</option></select></label></div><label>审查标准 <span class="required">必填</span><textarea v-model="r.instruction" rows="4" maxlength="10000" placeholder="例如：核查尾款是否以书面验收通过为前提。验收通过后 30 日内付款属于正常约定；未约定验收条件应提示风险；无法确定验收标准时标记需人工确认。" /></label><label class="inline-check"><input v-model="r.mandatory" type="checkbox" />必检项 <small class="muted">每次适用审查均需覆盖，无法判断也要明确报告。</small></label><details><summary>附加标签（选填）</summary><p class="muted">用于标注检查项主题，适用范围由上方规则包设置决定。</p><RuleTags v-model="r.tags" label="检查项标签" /></details></article>
          <button type="button" class="rule-add" @click="addRule">＋ 添加检查项</button>
        </section>
        <section class="rule-form-section"><div class="rule-form-heading"><span>03</span><div><h3>参考资料 <small>选填</small></h3><p>录入可追溯的公司制度、法律资料或参考条款，不确定的依据请先核实。</p></div></div><article v-for="(k, i) in form.knowledge" :key="k.id" class="rule-item"><header><b>参考资料 {{ i + 1 }}</b><button type="button" class="text-btn rule-remove" :aria-label="`删除参考资料 ${i + 1}`" @click="removeKnowledge(i)">删除</button></header><label>资料名称<input v-model="k.title" placeholder="例如：公司采购管理办法第十二条" /></label><label>引用内容<textarea v-model="k.content" rows="3" maxlength="20000" placeholder="填写与检查标准相关的准确原文或参考条款" /></label><div class="rule-field-grid"><label>可追溯来源<input v-model="k.source" placeholder="文件名称、条款编号或来源网址" /></label><label>生效日期<input v-model="k.effectiveDate" placeholder="例如：2026-10-01" /></label></div></article><button type="button" class="rule-add" @click="form.knowledge.push(newKnowledge())">＋ 添加参考资料</button></section>
      </fieldset>
      <div class="rule-editor-footer"><div><b>{{ dirty ? '有未保存的修改' : '填写后保存草稿' }}</b><small>保存草稿不会立即用于合同审查。</small></div><button type="button" :disabled="busy" @click="closeEditor()">取消</button><button class="primary" :disabled="busy">{{ busy ? '正在保存…' : '保存草稿' }}</button></div>
    </form>
  </el-dialog>
  <el-dialog v-model="classificationPublishConfirm" title="确认发布分类指导" width="500px" :close-on-click-modal="false"><p>本次发布将替换该类型当前生效的分类指导。后续新建预审使用此版本，历史分类和报告保持原样。</p><div class="dialog-actions"><button :disabled="classificationBusy" @click="classificationPublishConfirm=false">暂不发布</button><button class="primary" :disabled="classificationBusy" @click="publishClassification">确认发布并生效</button></div></el-dialog>
  <el-dialog v-model="discard" title="规则还没有保存" width="440px" :close-on-click-modal="false"><p>关闭后，本次填写的内容会丢失。已经保存的版本不受影响。</p><div class="dialog-actions"><button @click="discard = false">继续编辑</button><button @click="discard = false; show = false">放弃修改</button></div></el-dialog>
  <el-dialog v-model="classificationShow" title="编辑合同分类指导" width="760px" :close-on-click-modal="false" :before-close="closeClassification"><form v-if="classificationDraft" class="stack" @submit.prevent="saveClassification"><div class="notice">{{ classificationSource ? `本次修改来自反馈：${classificationSource.content}` : '保存会生成新的分类指导草稿，发布后才影响后续分类。' }}</div><label>分类说明<textarea v-model="classificationForm.description" rows="4" maxlength="10000" placeholder="说明该类型的交易实质和判断边界" required /></label><label>适用条件（每行一条）<textarea v-model="classificationForm.include" rows="4" placeholder="例如：以软件许可、定制开发或 SaaS 订阅为主要交易内容" /></label><label>排除条件（每行一条）<textarea v-model="classificationForm.exclude" rows="4" placeholder="例如：仅采购标准化硬件，不包含软件服务" /></label><label>典型示例（每行一条）<textarea v-model="classificationForm.examples" rows="4" placeholder="填写已确认的合同表述或案例" /></label><div class="dialog-actions"><button type="button" @click="closeClassification()" :disabled="classificationBusy">取消</button><button type="button" @click="saveClassification" :disabled="classificationBusy">保存草稿</button><button class="primary" type="button" @click="classificationPublishConfirm=true" :disabled="classificationBusy||classificationDirty||classificationDraft.state!=='draft'">发布此版本</button></div></form></el-dialog>
  <el-dialog :model-value="!!selected" title="规则内容与版本" width="850px" top="5vh" @close="selected = null"><div v-if="selected" class="rule-detail"><div class="rule-pack-title"><h2>{{ selected.name }}</h2><span class="badge" :class="selected.state">{{ label(selected.state) }}</span><span>第 {{ selected.version_no }} 版</span></div><p class="muted">{{ scopeText(selected.scope, catalog) }}</p><p v-if="selected.source_feedback_id" class="notice">来源反馈：<router-link :to="{path:'/feedback',query:{feedback:selected.source_feedback_id}}">查看法务反馈及原文</router-link></p><p v-if="selected.base_version_id" class="muted">修改基于第 {{ packs.find(p=>p.id===selected.base_version_id)?.version_no }} 版</p><details class="rule-version-history"><summary>版本变更记录</summary><article v-for="v in packs.filter(p=>p.pack_id===selected.pack_id)" :key="v.id" class="rule-readable"><button class="text-btn" @click="selected=v">第 {{ v.version_no }} 版 · {{ label(v.state) }}</button><small>创建：{{ time(v.created_at) }} · 最后保存：{{ time(v.updated_at) }}<template v-if="v.published_at"> · 发布：{{ time(v.published_at) }}</template></small><router-link v-if="v.source_feedback_id" :to="{path:'/feedback',query:{feedback:v.source_feedback_id}}">查看来源反馈</router-link></article></details><div v-for="(r, i) in selected.rules" :key="r.id" class="rule-readable"><div><b>{{ i + 1 }}. {{ r.title }}</b><span class="badge" :class="r.severity">{{ label(r.severity) }}</span><small>{{ r.mandatory ? '必检' : '未标为必检' }}</small></div><p class="prewrap">{{ r.instruction }}</p><div v-if="r.tags?.length" class="muted">标签：{{ r.tags.join('、') }}</div></div><h3 v-if="selected.knowledge.length">参考资料</h3><article v-for="k in selected.knowledge" :key="k.id" class="rule-readable"><b>{{ k.title }}</b><p class="prewrap">{{ k.content }}</p><small>来源：{{ k.source }} · 生效日期：{{ k.effectiveDate }}</small></article><p v-if="!selected.knowledge.length" class="muted">此版本未附参考资料。</p><details><summary>技术信息（供维护人员排查）</summary><pre class="json-view">{{ JSON.stringify(selected, null, 2) }}</pre></details><div class="dialog-actions"><button @click="selected = null">关闭</button><button v-if="selected.state==='pending'" class="primary" @click="action={pack:selected,kind:'publish'};selected=null">审核并发布</button><button v-if="role('publisher')" class="primary" @click="draft(selected); selected = null">基于此版修改</button></div></div></el-dialog>
  <el-dialog :model-value="!!action" :title="actionTitle" width="560px" :close-on-click-modal="false" :close-on-press-escape="!busy" :before-close="done => { if (!busy) { action = null; done(); } }"><template v-if="action"><div class="rule-action-summary"><b>{{ action.pack.name }} · 第 {{ action.pack.version_no }} 版</b><p>{{ scopeText(action.pack.scope, catalog) }}</p><span>{{ action.pack.rules.length }} 个检查项 · {{ action.pack.knowledge.length }} 份参考资料</span></div><p v-if="action.kind === 'submit'">提交后进入待审核状态，尚不会生效。请先确认检查标准已经填写完整。</p><template v-else-if="action.kind === 'publish'"><p>发布表示法务已审核本版标准。后续新建的预审会使用此版本，历史报告保持原样。</p><div v-if="liveVersion(action.pack)" class="notice">本次会替换并停用同一规则包当前生效的第 {{ liveVersion(action.pack).version_no }} 版，原版本作为历史版本保留。</div></template><div v-else class="notice danger">停用后，后续预审不再使用此规则包；若它是某合同类型唯一的专项规则，该类型将无法正式预审。历史记录保留。</div><p v-if="action.error" class="error-text" role="alert">{{ action.error }}</p><div class="dialog-actions"><button :disabled="busy" @click="action = null">暂不操作</button><button class="primary" :disabled="busy" @click="transition">{{ busy ? '正在处理…' : { submit: '确认提交审核', publish: '确认发布并生效', retire: '确认停用' }[action.kind] }}</button></div></template></el-dialog>
</template>
