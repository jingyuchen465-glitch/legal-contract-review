<script setup>
import { ref, computed, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { api, label, time } from './api';
import DocumentView from './DocumentView.vue';
import RevisionReview from './RevisionReview.vue';
import './agent-review.css';
const route=useRoute(), contract=ref(), run=ref(), error=ref(''), selected=ref('');
const selectedVersion=ref(''), locationRequest=ref(null);
const versions=computed(()=>[...new Map([...(contract.value?.versions || []),...(run.value?.documents || []).map(d=>d.version)].map(v=>[v.id,v])).values()]);
const version=computed(()=>versions.value.find(v=>v.id===selectedVersion.value));
const findings=computed(()=>(run.value?.findings || []).filter(f=>!f.evidence.length || f.evidence.some(e=>(e.versionId || run.value.version_id)===selectedVersion.value)));
function locate(e,id){selectedVersion.value=e ? e.versionId || run.value.version_id : selectedVersion.value || run.value.version_id;selected.value=id;locationRequest.value={findingId:id,evidence:e};}
function locateFinding(f){const evidence=f.evidence || [];locate(evidence.find(e=>(e.versionId || run.value.version_id)===selectedVersion.value) || evidence[0],f.id);}
onMounted(async()=>{try{[contract.value,run.value]=await Promise.all([api('/contracts/'+route.params.id),api('/reviews/'+route.params.reviewId)]);selectedVersion.value=run.value.version_id;}catch(e){error.value=e.message;}});
</script>
<template><section class="page-heading"><div><router-link :to="'/contracts/'+route.params.id">← 返回合同工作台</router-link><h1>历史审查记录</h1><p>{{ contract?.title }} · {{ time(run?.created_at) }}</p></div><a v-if="run" :href="'/api/reviews/'+run.id+'/report?format=html'" target="_blank" rel="noopener noreferrer">导出历史报告 ↗</a></section><p v-if="error" role="alert">{{ error }}</p><template v-if="run"><p class="notice">原文件、审查意见和人工结论按历史版本保留。旧规则与旧经验已停止用于新审查。</p><div v-if="run.decision" class="notice"><b>法务结论：{{ label(run.decision.outcome) }}</b><p>{{ run.decision.reason }} {{ run.decision.conditions }}</p><p v-if="run.decision.withdrawal">此结论已撤回：{{ run.decision.withdrawal.reason }}</p></div><label>历史材料<select v-model="selectedVersion"><option v-for="v in versions" :key="v.id" :value="v.id">{{v.filename}} · v{{v.version_no}}</option></select></label><div class="agent-layout"><DocumentView v-if="version" :version="version" :findings="findings" :key="version.id" :selected-finding-id="selected" :location-request="locationRequest" :editable="false" @select-finding="selected=$event" /><section class="panel"><RevisionReview :report="run.agent_result" :baseline="run.snapshot?.revisionBaseline" @locate="locate($event,'revision-'+$event.blockId)" /><article v-for="f in run.findings" :key="f.id" class="agent-finding"><h3><button type="button" class="agent-finding-link" @click="locateFinding(f)">{{ f.title }}</button> · {{ label(f.severity) }}</h3><p>{{ f.reason }}</p><blockquote v-for="e in f.evidence" :key="e.blockId+e.quote" role="button" tabindex="0" @click="locate(e,f.id)" @keydown.enter.prevent="locate(e,f.id)" @keydown.space.prevent="locate(e,f.id)">{{ e.quote }}</blockquote><p>{{ f.suggestion }}</p><p v-if="f.disposition">人工处理：{{ label(f.disposition.action) }} · {{ f.disposition.reason }}</p></article></section></div></template></template>
