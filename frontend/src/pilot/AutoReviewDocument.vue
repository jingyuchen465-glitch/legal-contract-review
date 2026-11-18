<script setup>
import { computed, defineAsyncComponent, ref, watch } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router';
import { api, role } from './api';

const WordReviewWorkspace = defineAsyncComponent(() => import('./WordReviewWorkspace.vue'));
const route = useRoute(), router = useRouter(), workspace = ref();
const source = ref(null), contractId = ref(''), readonly = ref(true), loading = ref(true), error = ref('');
const back = computed(() => `/auto-review/${route.params.id}`);
let generation = 0;

function descendsFrom(version, ancestorId, versions) {
  const seen = new Set();
  while (version && !seen.has(version.id)) {
    if (version.id === ancestorId) return true;
    seen.add(version.id);
    version = versions.get(version.parent_id);
  }
  return false;
}

async function load() {
  const request = ++generation;
  loading.value = true; error.value = ''; source.value = null;
  try {
    const batch = await api(`/auto-review-batches/${route.params.id}`, { quiet: true });
    if (request !== generation) return;
    const artifact = batch.artifacts.find(a => a.id === route.params.artifactId && ['annotated_comments', 'tracked_revisions'].includes(a.kind) && a.status === 'ready' && a.version_id);
    const document = batch.documents.find(d => d.id === artifact?.batch_document_id);
    if (!artifact || !document?.contract_id) throw new Error('这份建议稿尚不可打开，请返回批次查看生成状态');
    const contract = await api(`/contracts/${document.contract_id}`, { quiet: true });
    if (request !== generation) return;
    const versions = new Map(contract.versions.map(v => [v.id, v]));
    const draft = versions.get(artifact.version_id), current = versions.get(contract.current_version_id);
    if (!draft) throw new Error('建议稿版本不存在，请返回批次刷新');
    const latestReview = artifact.review_id === batch.main_review_id;
    const savedRevision = latestReview && descendsFrom(current, draft.id, versions);
    source.value = savedRevision ? current : draft;
    contractId.value = contract.id;
    readonly.value = !role('legal') || !latestReview || (!savedRevision && artifact.source_version_id !== contract.current_version_id);
  } catch (cause) { if (request === generation) error.value = cause.message; }
  finally { if (request === generation) loading.value = false; }
}

async function preserveEdits() { return !workspace.value || await workspace.value.saveForNavigation() !== false; }
onBeforeRouteLeave(preserveEdits);
onBeforeRouteUpdate(preserveEdits);
watch(() => [route.params.id, route.params.artifactId], load, { immediate: true });
</script>

<template>
  <p v-if="loading" role="status">正在打开自动评审建议稿…</p>
  <section v-else-if="error" class="panel padded"><p class="error-text" role="alert">{{ error }}</p><div class="action-row"><button @click="load">重新加载</button><router-link :to="back">返回自动评审批次</router-link></div></section>
  <WordReviewWorkspace v-else-if="source" ref="workspace" :key="source.id" :contract-id="contractId" :source-version="source" :readonly="readonly" :show-legacy="false" @close="router.push(back)" />
</template>
