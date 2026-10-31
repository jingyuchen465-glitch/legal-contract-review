<script setup>
import { ref, onMounted } from 'vue';
import { api, role, time } from './api';
import { dingCallback } from './dingtalk-callback';
import './settings.css';
const status=ref(null), loading=ref(true), busy=ref(false), error=ref(''), message=ref('');
async function load(){ status.value=await api('/dingtalk/account',{quiet:true}); }
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
        <ol><li>绑定账号，等待审批分配给你。</li><li>系统收到钉钉事件，核对当前办理人后下载 PDF、DOCX。</li><li>在「合同与待办」查看收取的文件；需要预审时补充业务背景。</li></ol>
        <p class="field-help">每份 PDF、DOCX 分别保存；其他格式跳过。同一附件内容不变时不重复建立记录。解绑会停止后续收取。</p>
        <p class="field-help">绑定前的历史审批不会自动全量补齐。应用审批权限和附件权限需由钉钉管理员授权，你本人无需担任法务或审批管理员。</p>
      </template>
    </div>
    <div v-if="status" class="config-actions"><router-link to="/">查看合同与待办 →</router-link><div><button v-if="status.account" @click="unbind" :disabled="busy">解除绑定</button><button class="primary" @click="bind" :disabled="busy||!status.configured">{{ busy?'正在处理…':status.account?'更换钉钉账号':'绑定钉钉账号' }}</button></div></div>
  </section>
</template>
