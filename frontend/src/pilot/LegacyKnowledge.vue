<script setup>
import { ref, onMounted } from 'vue';
import { api } from './api';
const packs=ref([]), error=ref(''), detail=ref(null);
onMounted(async()=>{try{const [rules,skills]=await Promise.all([api('/rule-packs'),api('/skill-packs')]);packs.value=[...(rules.items||rules).map(p=>({...p,kind:'规则',endpoint:'rule-packs'})),...(skills.items||skills).map(p=>({...p,kind:'技能',endpoint:'skill-packs'}))];}catch(e){error.value=e.message;}});
async function open(p){try{detail.value=p;}catch(e){error.value=e.message;}}
</script>
<template><section class="page-heading"><div><h1>历史知识库</h1><p>保留旧规则、技能和来源记录供查询；新 Agent 不再加载这些内容。</p></div><router-link to="/experience">返回新经验</router-link></section><p class="notice danger" v-if="error">{{error}}</p><div class="panel" style="padding:24px"><p v-for="p in packs" :key="p.kind+p.id"><button class="text-btn" @click="open(p)">{{p.kind}} · {{p.name||p.id}}</button></p><p v-if="!packs.length">暂无历史知识记录。</p></div><el-dialog :model-value="!!detail" @close="detail=null" title="历史版本详情" width="min(900px,95vw)"><pre style="white-space:pre-wrap;overflow-wrap:anywhere">{{JSON.stringify(detail,null,2)}}</pre></el-dialog></template>
