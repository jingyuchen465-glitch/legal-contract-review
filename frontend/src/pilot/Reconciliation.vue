<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { useRouter } from 'vue-router';
import { api, role, time } from './api';

const router = useRouter();
const items = ref([]), total = ref(0), page = ref(1), busy = ref(false), reviewStatus = ref('pending');
let timer;

async function load(quiet = false) {
  const params = new URLSearchParams({ page: String(page.value), intakeMode: 'reconciliation', intakeReviewStatus: reviewStatus.value });
  if (reviewStatus.value === 'pending') params.set('view', 'reconciliation-pending'); else params.set('view', 'all');
  const data = await api('/contracts?' + params, { quiet });
  items.value = data.items;
  total.value = data.total;
}
async function update(item, action) {
  if (busy.value) return;
  busy.value = true;
  try {
    await api(`/contracts/${item.id}/intake-${action}`, { method: 'POST', body: { revision: item.revision } });
    await load();
  } finally {
    busy.value = false;
  }
}
onMounted(async () => { await load(); timer = setInterval(() => load(true).catch(() => {}), 5000); });
onUnmounted(() => clearInterval(timer));
</script>

<template>
  <section class="page-heading">
    <div><div class="eyebrow">RECONCILIATION REVIEW</div><h1>补查待确认</h1><p>历史审批补查件先由法务确认，再进入正式待办。</p></div>
    <button class="text-btn" @click="load()">↻ 刷新</button>
  </section>
  <div class="notice">这里的合同不会计入主台账待法务处理数量。确认后会进入「合同与待办」，标记为无需处理的记录和附件仍会保留在补查记录中。</div>
  <div class="panel">
    <div class="panel-heading"><h2>{{ reviewStatus === 'pending' ? '待确认合同' : '补查处理记录' }} <span class="count">{{ total }}</span></h2><select v-model="reviewStatus" @change="page=1;load()" aria-label="补查记录状态"><option value="pending">待确认</option><option value="confirmed">已转入法务待办</option><option value="dismissed">无需处理</option></select></div>
    <div class="table-scroll"><table><thead><tr><th>合同名称</th><th>审批标题</th><th>收件时间</th><th>补查原因</th><th>附件</th><th></th></tr></thead>
      <tbody><tr v-for="item in items" :key="item.id" class="clickable" @click="router.push('/contracts/'+item.id)">
        <td><strong class="contract-title">{{ item.title }}</strong><small class="mono">{{ item.number }}</small></td>
        <td>{{ item.approvalTitle || '—' }}</td>
        <td class="muted nowrap">{{ time(item.receivedAt || item.created_at) }}</td>
        <td><span class="muted">{{ item.intakeReason || '接入后历史审批补查' }}</span></td>
        <td>{{ item.attachmentCount }} 份</td>
        <td><div v-if="item.intake_review_status === 'pending'" class="action-row"><button class="primary" :disabled="busy" @click.stop="update(item, 'confirm')">转入法务待办</button><button :disabled="busy" @click.stop="update(item, 'dismiss')">标记为无需处理</button></div><span v-else class="badge" :class="item.intake_review_status">{{ item.intake_review_status === 'confirmed' ? '已转入法务待办' : '无需处理' }}</span></td>
      </tr></tbody>
    </table></div>
    <div v-if="!items.length" class="empty-state compact"><span class="empty-icon">✓</span><h3>暂时没有待确认补查件</h3><p>新的历史补查件会出现在这里。</p></div>
  </div>
  <div class="action-row" style="justify-content:flex-end;margin:16px 0"><span class="muted">共 {{ total }} 份 · 第 {{ page }} / {{ Math.max(1, Math.ceil(total / 50)) }} 页</span><button :disabled="page <= 1" @click="page--;load()">上一页</button><button :disabled="page * 50 >= total" @click="page++;load()">下一页</button></div>
</template>
