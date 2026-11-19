<script setup>
import { ref, onMounted } from 'vue';
import { api, role, time, label } from './api';
import { dingCallback } from './dingtalk-callback';
import './settings.css';
const intakes=ref([]),jointSettings=ref(null);
const intakeName=s=>({collecting:'收取中',queued:'等待解析',analyzing:'建议分组中',ready:'待确认分组',failed:'需处理',confirmed:'已确认分组'}[s]||label(s));
async function toggleJoint(){busy.value=true;try{jointSettings.value=await api('/dingtalk/intake-settings',{method:'PUT',body:{enabled:!jointSettings.value.enabled,updatedAt:jointSettings.value.updatedAt}});}finally{busy.value=false;}}
const status=ref(null), loading=ref(true), busy=ref(false), error=ref(''), message=ref('');
async function load(){ const [s,i,j]=await Promise.all([api('/dingtalk/account',{quiet:true}),api('/dingtalk/intakes',{quiet:true}),api('/dingtalk/intake-settings',{quiet:true})]);status.value=s;intakes.value=i;jointSettings.value=j; }
async function bind(){busy.value=true;error.value='';try{const result=await api('/dingtalk/account/start',{method:'POST',body:{},quiet:true});window.location.assign(result.url);}catch(e){error.value=e.message;busy.value=false;}}
async function unbind(){busy.value=true;error.value='';try{await api('/dingtalk/account',{method:'DELETE',quiet:true});await load();message.value='已停止为此账号收取新附件，已收取的合同仍保留。';}catch(e){error.value=e.message;}finally{busy.value=false;}}
onMounted(async()=>{try{
  if(!role('business','legal'))return;
  if(dingCallback.input){const input=dingCallback.input;dingCallback.input=null;await api('/dingtalk/account/complete',{method:'POST',body:input,quiet:true});message.value='钉钉账号绑定成功。';}
  else if(dingCallback.error){error.value=dingCallback.error;dingCallback.error='';}
}catch(e){error.value=e.message;}finally{try{if(role('business','legal'))await load();}catch(e){error.value=e.message;}loading.value=false;}});
</script>

<template>
  <section class="page-heading"><div><div class="eyebrow">DINGTALK INBOX</div><h1>钉钉收件</h1><p>审批分配给你时，自动把审批表里的合同附件收进工作台。</p></div></section>
  <section v-if="!role('business','legal')" class="panel config-panel"><div class="config-panel-body">接收合同需要业务或法务角色，请联系管理员设置账号角色。</div></section>
  <section v-else class="panel config-panel">
    <div class="config-panel-title"><div><span class="config-kicker">我的接收账号</span><h2>{{ status?.account?.displayName || '绑定你的钉钉账号' }}</h2><p>{{ status?.account ? '绑定于 '+time(status.account.boundAt) : '使用审批实际分配到的钉钉账号完成授权。' }}</p></div><span v-if="status" class="badge" :class="status.account&&status.enabled?'completed':'waiting_input'">{{ status.account?(status.enabled?'已绑定 · 接入已启用':'已绑定 · 接入已暂停'):'尚未绑定' }}</span></div>
    <div class="config-panel-body">
      <p v-if="loading" role="status">正在读取绑定状态…</p>
      <p v-if="error" class="config-error" role="alert">{{ error }}</p><p v-if="message" role="status">{{ message }}</p>
      <template v-if="status">
        <div v-if="!status.configured" class="connection-result warning"><p>请管理员先在「接入与模型配置」中保存钉钉应用凭据。</p></div>
        <div v-else-if="!status.enabled" class="connection-result warning"><p>自动接入已暂停。你可以先绑定账号，由管理员启用后开始收取。</p></div>
        <ol><li>绑定账号，等待审批分配给你。</li><li>系统收到钉钉事件，核对当前办理人后下载 PDF、Word、Excel、CSV、PPT 及 ODF 文件。</li><li>在「自动评审」查看整个附件包的进度，下载报告和 Word 修订稿。</li></ol>
        <p class="field-help">新审批的全部附件会自动形成评审批次，由 Agent 判断材料角色、生成计划、执行审查与复核并生成改稿；不支持或失败的文件会列明原因。历史收件仍保持原方式。同一附件内容不变时不重复建立记录。解绑会停止后续收取。</p>
        <p class="field-help">确认稿目前通过下载后人工回传原审批；页面内会显示任务进度，尚未发送钉钉进度通知。</p><p class="field-help">绑定前的历史审批不会自动全量补齐。应用审批权限和附件权限需由钉钉管理员授权，你本人无需担任法务或审批管理员。</p>
      </template>
    </div>
    <div v-if="status" class="config-actions"><router-link to="/">查看合同与待办 →</router-link><div><button v-if="status.account" @click="unbind" :disabled="busy">解除绑定</button><button class="primary" @click="bind" :disabled="busy||!status.configured">{{ busy?'正在处理…':status.account?'更换钉钉账号':'绑定钉钉账号' }}</button></div></div>
  </section>
  <section v-if="jointSettings" class="panel config-panel"><div class="config-panel-body"><h2>新审批多附件审查</h2><p v-if="jointSettings.autoReviewEnabled">自动评审已启用：同一审批附件包自动进入评审，无需人工确认分组。</p><p v-else>{{ jointSettings.enabled?'已启用':'未启用' }} · 仅对首次收取的新审批生效，历史审批及其后续更新沿用原方式。</p><button v-if="role('admin') && !jointSettings.autoReviewEnabled" :disabled="busy" @click="toggleJoint">{{jointSettings.enabled?'暂停新流程':'启用新收件流程'}}</button><h3>审批收件包</h3><p v-if="!intakes.length" class="muted">暂无新流程收件。</p><p v-for="i in intakes" :key="i.id"><router-link :to="i.autoReviewBatchId ? '/auto-review/'+i.autoReviewBatchId : '/dingtalk/intakes/'+i.id">{{i.title}} →</router-link> · {{intakeName(i.status)}} · {{time(i.created_at)}}</p></div></section>
</template>
