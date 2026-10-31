<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { api, time, session, loadSession } from './api';
import { ElMessage } from 'element-plus/es/components/message/index.mjs';
import './settings.css';


const settings=ref(null), users=ref([]), loading=ref(true), loadError=ref(''), tab=ref('model');
const model=ref({baseUrl:'',name:'',apiKey:''}), connection=ref({enabled:false,clientId:'',clientSecret:''}), archive=ref({enabled:false,root:''});
const versions=ref({model:null,connection:null,archive:null});
const baselines=ref({model:'',connection:'',archive:''}), busy=ref({}), errors=ref({}), models=ref([]), modelProbe=ref(null), dingProbe=ref(null), diagnostics=ref([]), diagnosticsError=ref('');
const showKey=ref(false), showSecret=ref(false), modelForm=ref(), connectionForm=ref();
const showUser=ref(false), editingId=ref(null), userSearch=ref(''), userError=ref('');
const emptyUser=()=>({username:'',password:'',displayName:'',department:'',roles:['admin'],active:true});
const user=ref(emptyUser());
const tabs=[{id:'model',number:'01',name:'AI 模型',hint:'服务连接与模型选择'},{id:'dingtalk',number:'02',name:'钉钉接入',hint:'应用连接与账号绑定'},{id:'services',number:'03',name:'部署与服务',hint:'运行检查与配置说明'},{id:'users',number:'04',name:'管理员账号',hint:'成员信息与登录管理'}];
const presets=[{id:'deepseek',name:'DeepSeek',hint:'官方兼容接口',baseUrl:'https://api.deepseek.com/v1',model:'deepseek-chat'},{id:'bailian',name:'阿里云百炼',hint:'国内兼容接口',baseUrl:'https://dashscope.aliyuncs.com/compatible-mode/v1',model:'qwen-plus'},{id:'local',name:'本机 / 私有网关',hint:'本机 Ollama 等服务',baseUrl:'http://localhost:11434/v1',model:''},{id:'custom',name:'其他兼容服务',hint:'填写指定接口',baseUrl:'',model:''}];
const presetId=computed(()=>presets.find(p=>p.id!=='custom'&&model.value.baseUrl.startsWith(p.baseUrl))?.id||'custom');
const serialize=v=>JSON.stringify(v);
const modelDirty=computed(()=>!!baselines.value.model&&serialize(model.value)!==baselines.value.model);
const connectionDirty=computed(()=>!!baselines.value.connection&&serialize(connection.value)!==baselines.value.connection);
const archiveDirty=computed(()=>!!baselines.value.archive&&serialize(archive.value)!==baselines.value.archive);
const dirty=computed(()=>modelDirty.value||connectionDirty.value||archiveDirty.value);
const filteredUsers=computed(()=>users.value.filter(u=>`${u.username} ${u.displayName} ${u.department}`.toLowerCase().includes(userSearch.value.toLowerCase())));
const activeAccounts=computed(()=>users.value.filter(u=>u.active).length);
const keyRequired=computed(()=>!settings.value?.model.hasKey||model.value.baseUrl.trim().replace(/\/$/,'')!==settings.value.model.baseUrl);
const activeModelProbe=computed(()=>modelProbe.value?.signature===serialize(model.value)?modelProbe.value.result:!modelDirty.value?settings.value?.model.check:null);
const activeDingProbe=computed(()=>dingProbe.value?.signature===serialize(connection.value)?dingProbe.value.result:null);
const savedModelLabel=computed(()=>({success:'连接已验证',error:'连接失败',warning:'需确认兼容性',unconfigured:'待配置'}[settings.value?.model.check?.status]||(settings.value?.model.hasKey?'已配置，待验证':'待配置')));
const statusText=s=>({success:'验证通过',warning:'需进一步确认',error:'验证失败',unconfigured:'尚未配置'}[s]||'尚未验证');
const deploymentCards=computed(()=>settings.value?[{id:'ocr',name:'扫描识别 OCR',description:'仅扫描件、混合 PDF 的扫描页需要此服务。',configured:settings.value.services.ocrConfigured,detail:settings.value.services.ocrUrl,env:'OCR_URL=http://localhost:8090\nOCR_TOKEN=填写内部服务凭据'},{id:'office',name:'在线编辑 OnlyOffice',description:'用于 DOCX 在线编辑；也可先在本机 Word 修改后上传。',configured:settings.value.services.officeConfigured,detail:settings.value.services.officeUrl,env:'ONLYOFFICE_URL=http://localhost:8081\nONLYOFFICE_INTERNAL_URL=http://localhost:8081\nONLYOFFICE_JWT_SECRET=填写编辑器签名密钥\nBACKEND_URL_FOR_DOCKER=http://host.docker.internal:3000'},{id:'milvus',name:'知识检索 Milvus',description:'用于长资料包检索；必检规则始终完整执行。',configured:settings.value.services.milvusConfigured,detail:settings.value.services.milvusAddress,env:'MILVUS_ADDRESS=localhost:19530\nEMBEDDING_MODEL=填写向量模型名称\nMILVUS_TOKEN=按部署要求填写'},{id:'jev',name:'Jev 分类评测',description:'可选的离线对比方案，不影响默认分类。',configured:settings.value.jev.hasKey,detail:settings.value.jev.model,env:'JEV_API_KEY=填写评测服务密钥\nJEV_MODEL=jev-1.14.0'}]:[]);
function syncModel(){model.value={baseUrl:settings.value.model.baseUrl,name:settings.value.model.name,apiKey:''};baselines.value.model=serialize(model.value);versions.value.model=settings.value.model.updatedAt;showKey.value=false;}
function syncConnection(){connection.value={enabled:settings.value.dingtalk.enabled,clientId:settings.value.dingtalk.clientId,clientSecret:''};baselines.value.connection=serialize(connection.value);versions.value.connection=settings.value.dingtalk.connectionUpdatedAt;showSecret.value=false;}
function syncArchive(){archive.value={enabled:settings.value.archive?.enabled===true,root:settings.value.archive?.root||''};baselines.value.archive=serialize(archive.value);versions.value.archive=settings.value.archive?.updatedAt||null;}
async function refreshSettings(){settings.value=await api('/settings',{quiet:true});}
async function load(){loading.value=true;loadError.value='';try{const values=await Promise.all([api('/settings',{quiet:true}),api('/users',{quiet:true})]);settings.value=values[0];users.value=values[1];syncModel();syncConnection();syncArchive();}catch(e){loadError.value=e.message;}finally{loading.value=false;}}
function choosePreset(p){model.value.baseUrl=p.baseUrl;model.value.name=p.model;model.value.apiKey='';models.value=[];errors.value.model='';}
function normalizeUrl(){model.value.baseUrl=model.value.baseUrl.trim().replace(/\/+$/,'').replace(/\/(chat\/completions|models|embeddings)$/i,'');}
async function perform(key,task){if(busy.value[key])return;busy.value[key]=true;errors.value[key]='';try{await task();}catch(e){errors.value[key]=e.message;}finally{busy.value[key]=false;}}
async function checkModel(){if(!modelForm.value.reportValidity())return;await perform('model',async()=>{normalizeUrl();const signature=serialize(model.value),result=await api('/settings/model/test',{method:'POST',body:model.value,quiet:true});modelProbe.value={signature,result};await refreshSettings();});}
async function saveModel(verify=false){if(!modelForm.value.reportValidity())return;await perform('model',async()=>{normalizeUrl();await api('/settings/model',{method:'PUT',body:{...model.value,expectedUpdatedAt:versions.value.model},quiet:true});await refreshSettings();syncModel();modelProbe.value=null;ElMessage.success('模型配置已保存，新预审将使用此配置');if(verify){const signature=serialize(model.value),result=await api('/settings/model/test',{method:'POST',body:model.value,quiet:true});modelProbe.value={signature,result};await refreshSettings();}});}
async function discoverModels(){if(!model.value.baseUrl||keyRequired.value&&!model.value.apiKey){errors.value.model='请先填写服务地址和对应的 API 密钥，再读取模型列表';return;}await perform('models',async()=>{normalizeUrl();const result=await api('/settings/model/models',{method:'POST',body:{...model.value,name:model.value.name||'_discovery_'},quiet:true});models.value=result.models||[];if(result.status!=='success')errors.value.model=result.message;else ElMessage.success(result.message);});}
async function reloadPart(key){await perform(key,async()=>{await refreshSettings();({model:syncModel,connection:syncConnection,archive:syncArchive})[key]();});}
async function saveConnection(){if(!connectionForm.value.reportValidity())return;await perform('connection',async()=>{await api('/settings/dingtalk-connection',{method:'PUT',body:{...connection.value,expectedUpdatedAt:versions.value.connection},quiet:true});await refreshSettings();syncConnection();ElMessage.success('连接配置已保存，Worker 会在约 15 秒内应用');});}
async function saveArchive(){await perform('archive',async()=>{const result=await api('/settings/archive-root',{method:'PUT',body:{...archive.value,expectedUpdatedAt:versions.value.archive},quiet:true});settings.value.archive=result.archive;syncArchive();ElMessage.success(archive.value.enabled?'分类归档目录已保存':'自动分类归档已关闭');});}
async function checkDing(){await perform('connection',async()=>{const signature=serialize(connection.value),result=await api('/settings/dingtalk/test',{method:'POST',body:connection.value,quiet:true});dingProbe.value={signature,result};});}
async function runDiagnostics(){diagnosticsError.value='';busy.value.diagnostics=true;try{diagnostics.value=(await api('/settings/diagnostics',{method:'POST',body:{},quiet:true})).checks;await refreshSettings();}catch(e){diagnosticsError.value=e.message;}finally{busy.value.diagnostics=false;}}
function openUser(u){userError.value='';editingId.value=u?.id||null;user.value=u?{...u,roles:['admin'],password:''}:emptyUser();showUser.value=true;}
async function saveUser(){busy.value.user=true;userError.value='';try{const body={...user.value,roles:['admin']};if(editingId.value){delete body.password;await api('/users/'+editingId.value,{method:'PATCH',body,quiet:true});}else await api('/users',{method:'POST',body,quiet:true});if(editingId.value===session.user.id){await loadSession();}users.value=await api('/users',{quiet:true});showUser.value=false;ElMessage.success(editingId.value?'账号信息已更新':'账号已创建');}catch(e){userError.value=e.message;}finally{busy.value.user=false;}}
function beforeUnload(e){if(dirty.value){e.preventDefault();e.returnValue='';}}
onBeforeRouteLeave(()=>!dirty.value||window.confirm('有尚未保存的配置，离开后将丢失这些更改。确定离开吗？'));
let runtimeTimer;
onMounted(()=>{load();window.addEventListener('beforeunload',beforeUnload);runtimeTimer=setInterval(async()=>{if(tab.value!=='dingtalk'||!settings.value)return;try{const data=await api('/settings',{quiet:true});settings.value.dingtalk.runtime=data.dingtalk.runtime;}catch{}},15000);});onBeforeUnmount(()=>{clearInterval(runtimeTimer);window.removeEventListener('beforeunload',beforeUnload);});
</script>

<template>
  <div class="settings-page">
    <section class="page-heading settings-heading"><div><div class="eyebrow">WORKSPACE SETTINGS</div><h1>接入与模型配置</h1><p>先连接模型，即可开始准备审查。钉钉和扩展服务可按需启用。</p></div><span class="settings-local"><i></i> 本机试点</span></section>
    <div v-if="loading" class="panel settings-loading" role="status">正在读取配置…</div>
    <div v-else-if="loadError" class="panel settings-loading"><p role="alert">{{ loadError }}</p><button @click="load">重新加载</button></div>
    <template v-else-if="settings">
      <div class="settings-overview"><div><span class="overview-dot" :class="settings.model.check?.status==='success'?'good':settings.model.check?.status==='error'?'bad':settings.model.hasKey?'pending':''"></span><span>AI 模型</span><b>{{ savedModelLabel }}</b></div><div><span class="overview-dot" :class="settings.dingtalk.enabled?'good':''"></span><span>合同接收</span><b>{{ settings.dingtalk.enabled?'手动上传 + 钉钉':'手动上传已可用' }}</b></div><div><span class="overview-dot good"></span><span>已启用账号</span><b>{{ activeAccounts }} 位</b></div></div>
      <div class="settings-layout">
        <aside class="settings-nav" aria-label="配置分类"><button v-for="item in tabs" :key="item.id" @click="tab=item.id" :class="{selected:tab===item.id}" :aria-current="tab===item.id?'page':undefined"><span>{{ item.number }}</span><div><b>{{ item.name }}</b><small>{{ item.hint }}</small></div><i v-if="item.id==='model'&&modelDirty||item.id==='dingtalk'&&connectionDirty||item.id==='services'&&archiveDirty" title="有未保存更改"></i></button><div class="settings-nav-note"><b>从手动上传开始</b><p>连接模型、发布公司审查规则后，即可试用。其他服务按合同需要逐步配置。</p></div></aside>
        <div class="settings-content">
          <section v-show="tab==='model'" aria-label="AI 模型配置">
            <form ref="modelForm" class="panel config-panel" @submit.prevent="saveModel(true)">
              <div class="config-panel-title"><div><span class="config-kicker">核心配置</span><h2>连接审查模型</h2><p>分类与合同初审使用同一指定模型服务。</p></div><span class="badge" :class="activeModelProbe?.status==='success'?'completed':'waiting_input'">{{ activeModelProbe?statusText(activeModelProbe.status):settings.model.hasKey?'已保存，待验证':'尚未配置' }}</span></div>
              <div class="config-panel-body" :inert="busy.model||busy.models?true:undefined">
                <fieldset class="provider-fieldset"><legend>选择服务类型</legend><div class="provider-options"><button v-for="p in presets" :key="p.id" type="button" @click="choosePreset(p)" :class="{selected:presetId===p.id}" :aria-pressed="presetId===p.id"><b>{{ p.name }}</b><small>{{ p.hint }}</small><span v-if="presetId===p.id">✓</span></button></div><p class="field-help">预填地址与模型可自行修改；请确认账号已开通对应模型权限。</p></fieldset>
                <label>服务地址 <span class="required-mark">*</span><input v-model="model.baseUrl" @blur="normalizeUrl" type="url" required maxlength="2000" placeholder="https://your-provider.example/v1" autocomplete="off" :disabled="busy.model" /><span class="field-help">填写 API 基础地址。粘贴完整的 /chat/completions 地址时会自动整理。</span></label>
                <label>API 密钥 <span v-if="keyRequired" class="required-mark">*</span><div class="secret-input"><input v-model="model.apiKey" :type="showKey?'text':'password'" :required="keyRequired" :placeholder="keyRequired?'填写此服务的 API 密钥':'已保存密钥，留空保留原值'" autocomplete="new-password" :disabled="busy.model" /><button type="button" @click="showKey=!showKey" :aria-label="showKey?'隐藏 API 密钥':'显示本次输入的 API 密钥'">{{ showKey?'隐藏':'显示' }}</button></div><span class="field-help">密钥加密保存在服务端。无鉴权的本机服务可填写 local；更换地址时需重新填写密钥。</span></label>
                <label>模型名称 <span class="required-mark">*</span><div class="input-action"><input v-model="model.name" required maxlength="200" list="available-models" placeholder="例如 deepseek-chat 或 qwen-plus" :disabled="busy.model" /><button type="button" @click="discoverModels" :disabled="busy.models||busy.model">{{ busy.models?'正在读取…':'读取可选模型' }}</button></div><datalist id="available-models"><option v-for="m in models" :key="m" :value="m" /></datalist><span class="field-help">使用服务商提供的模型 ID；不支持读取列表的服务可直接手动填写。</span></label>
                <div v-if="activeModelProbe" class="connection-result" :class="activeModelProbe.status" role="status"><b>{{ statusText(activeModelProbe.status) }} <small>{{ activeModelProbe.elapsedMs }} ms</small></b><p>{{ activeModelProbe.message }}</p><small>{{ time(activeModelProbe.checkedAt) }}{{ modelDirty?' · 本次为未保存配置的测试':'' }}</small></div>
                <p v-if="errors.model" class="config-error" role="alert">{{ errors.model }} <button v-if="errors.model.includes('已被更新')" type="button" @click="reloadPart('model')">重新载入模型配置</button></p>
                <p v-if="errors.models" class="config-error" role="alert">{{ errors.models }}</p>
                <div class="config-footnote"><span>↗</span><p>连接测试仅发送固定测试文本。正式预审会将合同内容发送到你指定的服务地址。</p></div>
              </div>
              <div class="config-actions"><span :class="modelDirty?'unsaved':'muted'">{{ modelDirty?'● 有未保存更改':settings.model.hasKey?'配置已保存':'填写完成后保存并验证' }}</span><button v-if="modelDirty" type="button" @click="syncModel" :disabled="busy.model">撤销更改</button><div><button type="button" @click="checkModel" :disabled="busy.model||busy.models">测试连接</button><button type="button" @click="saveModel(false)" :disabled="busy.model">仅保存</button><button class="primary" :disabled="busy.model||busy.models">{{ busy.model?'正在处理…':'保存并验证' }}</button></div></div>
            </form>
            <div class="settings-tip"><span>下一步</span><p>由法务人员确认并发布公司审查标准，再上传一份测试合同验证完整流程。模型连通不代表审查质量已经达标。</p></div>
          </section>

          <section v-show="tab==='dingtalk'" aria-label="钉钉接入配置">
            <div class="settings-tip"><span>可选接入</span><p>自动读取钉钉审批附件；最终审核意见仍由法务人工回传。未启用时，可正常手动上传合同。</p></div>
            <form ref="connectionForm" class="panel config-panel" @submit.prevent="saveConnection">
              <div class="config-panel-title"><div><span class="config-kicker">第一步 · 应用连接</span><h2>连接企业内部应用</h2><p>从钉钉开发者后台获取应用标识和密钥。</p></div><span class="badge" :class="settings.dingtalk.hasCredentials?'completed':'waiting_input'">{{ settings.dingtalk.hasCredentials?'凭据已保存':'待填写凭据' }}</span></div>
              <div class="config-panel-body" :inert="busy.connection?true:undefined"><label>Client ID / AppKey<input v-model="connection.clientId" placeholder="输入企业内部应用的 Client ID" maxlength="200" autocomplete="off" /></label><label>Client Secret / AppSecret<div class="secret-input"><input v-model="connection.clientSecret" :type="showSecret?'text':'password'" :placeholder="settings.dingtalk.hasSecret?'已保存密钥，留空保留原值':'输入应用密钥'" autocomplete="new-password" /><button type="button" @click="showSecret=!showSecret" :aria-label="showSecret?'隐藏应用密钥':'显示本次输入的应用密钥'">{{ showSecret?'隐藏':'显示' }}</button></div><span class="field-help">只保存在服务端，不显示已保存的密钥。</span></label>
                <label class="config-toggle"><input type="checkbox" v-model="connection.enabled" /><span><b>启用钉钉自动接入</b><small>保存后由 Worker 在约 15 秒内应用。每位接收人还需绑定自己的钉钉账号。</small></span></label>
                <div v-if="activeDingProbe" class="connection-result" :class="activeDingProbe.status" role="status"><b>{{ statusText(activeDingProbe.status) }}</b><p>{{ activeDingProbe.message }}</p><small>{{ time(activeDingProbe.checkedAt) }}</small></div><p v-if="errors.connection" class="config-error" role="alert">{{ errors.connection }} <button v-if="errors.connection.includes('已被更新')" type="button" @click="reloadPart('connection')">重新载入连接配置</button></p>
                <div v-if="settings.dingtalk.runtime" class="field-help">Worker 上次应用：{{ time(settings.dingtalk.runtime.appliedAt) }} · {{ settings.dingtalk.runtime.status==='connected'?'已应用启用配置，事件与附件仍需实际联调':settings.dingtalk.runtime.status==='disabled'?'自动接入已暂停':settings.dingtalk.runtime.message }}</div>
              </div><div class="config-actions"><span :class="connectionDirty?'unsaved':'muted'">{{ connectionDirty?'● 有未保存更改':'应用鉴权与审批权限分别验证' }}</span><button v-if="connectionDirty" type="button" @click="syncConnection">撤销更改</button><div><button type="button" @click="checkDing" :disabled="busy.connection">验证应用凭据</button><button class="primary" :disabled="busy.connection">{{ busy.connection?'正在处理…':'保存连接配置' }}</button></div></div>
            </form>
            <section class="panel config-panel">
              <div class="config-panel-title"><div><span class="config-kicker">第二步 · 绑定接收人</span><h2>审批到谁，就收进谁的工作台</h2><p>当前应用已有 {{ settings.dingtalk.boundAccounts }} 位接收人绑定账号。</p></div></div>
              <div class="config-panel-body">
                <p>请每位接收人登录自己的工作台，在「钉钉收件」中授权绑定钉钉账号。所有管理员账号均可使用。</p>
                <p>审批分配给已绑定账号时，自动下载表单中的全部 PDF、DOCX；多份文件分别建立记录，其他格式跳过。缺少业务背景时，在合同详情中补充即可。</p>
                <router-link v-if="session.user.roles.includes('admin')" to="/dingtalk">打开我的钉钉收件 →</router-link>
                <p v-else class="field-help">管理员账号可以直接接收合同、复核结果和维护规则。</p>
                <details><summary>钉钉管理员需要配置什么</summary>
                  <ol><li>在企业内部应用中配置网页登录，回调地址填写：<code>{{ settings.dingtalk.callbackUrl }}</code></li><li>开通个人信息读取、通过 UnionID 获取企业 UserID、审批实例读取及附件下载权限，并覆盖接收人的应用可访问范围。</li><li>事件订阅选择 Stream，订阅审批任务变更事件 bpms_task_change，并发布生效。</li><li>保存应用凭据并启用接入，接收人完成绑定后，用一张新分配的审批单测试。</li></ol>
                  <p class="field-help">此处不需要审批模板编号、法务节点名称或附件字段名称。历史未收到事件的审批不会自动补齐；已收到事件的审批每 5 分钟复查一次，持续 30 天。</p>
                </details>
              </div>
            </section>
          </section>

          <section v-show="tab==='services'" aria-label="部署与服务检查">
            <form class="panel config-panel" @submit.prevent="saveArchive">
              <div class="config-panel-title"><div><span class="config-kicker">分类归档</span><h2>自动保存到分类目录</h2><p>法务确认合同分类后，系统会把当前合同附件复制到主目录下的分类子目录。</p></div><span class="badge" :class="archive.enabled?'completed':'waiting_input'">{{ archive.enabled?'已启用':'未启用' }}</span></div>
              <div class="config-panel-body"><label class="config-toggle"><input type="checkbox" v-model="archive.enabled" /><span><b>启用分类归档</b><small>只复制文件，不删除系统原始文件；分类变化后会按新分类再次归档。</small></span></label><label>归档主目录 <span class="required-mark" v-if="archive.enabled">*</span><input v-model="archive.root" :required="archive.enabled" maxlength="1000" placeholder="例如 D:\\法务合同归档 或 \\NAS\\法务合同" /><span class="field-help">必须是 API / Worker 所在电脑能够读写的绝对路径。目录结构示例：主目录 / 生产采购合同 / 采购合同 / 合同编号。</span></label><div class="config-footnote"><span>↗</span><p>确认分类后自动复制当前版本附件。未配置或归档失败不会删除合同，也不会影响数据库中的分类结果。</p></div><p v-if="errors.archive" class="config-error" role="alert">{{ errors.archive }} <button v-if="errors.archive.includes('已被更新')" type="button" @click="reloadPart('archive')">重新载入归档配置</button></p></div>
              <div class="config-actions"><span :class="archiveDirty?'unsaved':'muted'">{{ archiveDirty?'● 有未保存更改':archive.enabled?'归档目录已保存':'自动归档未启用' }}</span><button v-if="archiveDirty" type="button" @click="syncArchive">撤销更改</button><button class="primary" :disabled="busy.archive">{{ busy.archive?'正在保存…':'保存归档配置' }}</button></div>
            </form>
            <div class="panel config-panel"><div class="config-panel-title"><div><span class="config-kicker">运行检查</span><h2>检查当前电脑上的服务</h2><p>实际检查数据库、任务进程、存储目录及已配置的内部服务。</p></div><button class="primary" @click="runDiagnostics" :disabled="busy.diagnostics">{{ busy.diagnostics?'正在检查…':'检查服务状态' }}</button></div><div class="config-panel-body"><div v-if="!diagnostics.length" class="diagnostics-empty"><span>◎</span><p>点击检查，查看服务是否可达。<br><small>配置已填写与连接已验证会分别显示。</small></p></div><div v-for="check in diagnostics" :key="check.id" class="diagnostic-row"><span class="overview-dot" :class="check.status==='success'?'good':check.status==='error'?'bad':'pending'"></span><div><b>{{ check.name }}</b><p>{{ check.message }}</p></div><span class="badge" :class="check.status==='success'?'completed':check.status==='error'?'high':'waiting_input'">{{ check.status==='success'?'检查通过':statusText(check.status) }}</span></div><p v-if="diagnostics.length" class="field-help">检查时间 {{ time(diagnostics[0].checkedAt) }}。服务可达后，仍需验证真实文件识别、编辑和回调。</p><p v-if="diagnosticsError" class="config-error" role="alert">{{ diagnosticsError }}</p></div></div>
            <div class="settings-service-grid"><article v-for="service in deploymentCards" :key="service.id" class="panel deployment-card"><div><h3>{{ service.name }}</h3><span class="badge" :class="service.configured?'completed':'waiting_input'">{{ service.configured?'部署配置已填写':'按需配置' }}</span></div><p>{{ service.description }}</p><code v-if="service.detail">{{ service.detail }}</code><details><summary>如何配置此服务</summary><p>由部署人员在项目 .env 中填写，随后重启 API 与 Worker。</p><pre>{{ service.env }}</pre></details></article></div>
            <div class="panel storage-summary"><span>文件存储位置</span><code>{{ settings.services.storageRoot }}</code><small>预审任务并发 {{ settings.model.concurrency }} · OCR 并发 1。存储路径由部署配置管理，修改前请先备份。</small></div>
          </section>

          <section v-show="tab==='users'" aria-label="管理员账号管理"><div class="panel config-panel"><div class="config-panel-title"><div><span class="config-kicker">成员管理</span><h2>统一管理员账号</h2><p>所有使用人员都拥有合同处理、法务复核、规则维护和评测权限；部门仅作为备注保存。</p></div><button class="primary" @click="openUser()">＋ 创建管理员账号</button></div><div class="accounts-tools"><input v-model="userSearch" aria-label="搜索账号" placeholder="搜索姓名、账号或部门…" /><span>{{ filteredUsers.length }} 个账号 · {{ activeAccounts }} 个启用</span></div><div class="table-scroll"><table class="settings-users-table"><thead><tr><th>成员</th><th>部门备注</th><th>权限</th><th>状态</th><th></th></tr></thead><tbody><tr v-for="u in filteredUsers" :key="u.id"><td><div class="settings-member"><span>{{ u.displayName.slice(0,1) }}</span><div><b>{{ u.displayName }} <small v-if="u.id===session.user.id" class="self-label">当前账号</small></b><small>{{ u.username }}</small></div></div></td><td>{{ u.department||'未设置' }}</td><td><span class="badge completed">系统管理员</span></td><td><span class="badge" :class="u.active?'completed':'cancelled'">{{ u.active?'启用':'已停用' }}</span></td><td><button @click="openUser(u)">编辑</button></td></tr></tbody></table><div v-if="!filteredUsers.length" class="diagnostics-empty"><p>没有匹配的账号，请调整搜索条件。</p></div></div><div class="accounts-note">每个管理员账号都会写入操作审计，建议每位法务使用自己的账号登录。</div></div></section>
        </div>
      </div>
    </template>
    <el-dialog v-model="showUser" :title="editingId?'编辑管理员账号':'创建管理员账号'" width="600px" :close-on-click-modal="false"><form class="stack settings-user-form" @submit.prevent="saveUser"><div class="config-field-pair"><label>登录账号<input v-model="user.username" :disabled="!!editingId" required pattern="[a-zA-Z0-9_.-]{3,64}" placeholder="3–64 位字母、数字或下划线" autocomplete="off" /></label><label>显示姓名<input v-model="user.displayName" required maxlength="100" placeholder="成员姓名" /></label></div><label v-if="!editingId">初始密码<input v-model="user.password" type="password" required minlength="12" maxlength="200" autocomplete="new-password" placeholder="至少 12 位，用于首次登录" /></label><label>部门备注<input v-model="user.department" maxlength="100" placeholder="可选，例如：采购法务部" /></label><label>账号状态<select v-model="user.active"><option :value="true">启用</option><option :value="false">停用 · 将使已有登录失效</option></select></label><p v-if="userError" class="config-error" role="alert">{{ userError }}</p><div class="dialog-actions"><button type="button" @click="showUser=false" :disabled="busy.user">取消</button><button class="primary" :disabled="busy.user">{{ busy.user?'正在保存…':editingId?'保存账号':'创建账号' }}</button></div></form></el-dialog>
  </div>
</template>
