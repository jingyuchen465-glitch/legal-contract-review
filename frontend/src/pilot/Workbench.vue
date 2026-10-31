<script setup>
import { computed, ref, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, session, loadSession, role } from './api';
const route = useRoute(), router = useRouter();
const loading = ref(false), login = ref({ username: '', password: '' }), error = ref('');
const pages = computed(() => [
  { path: '/', name: '合同与待办', icon: '▤', show: true, section: '工作空间' },
  { path: '/reconciliation', name: '补查待确认', icon: '↺', show: role('legal') },
  { path: '/dingtalk', name: '钉钉收件', icon: '↓', show: role('admin', 'business', 'legal') },
  { path: '/rules', name: '分类与规则中心', icon: '▦', show: role('admin', 'legal', 'publisher') },
  { path: '/feedback', name: '反馈与评测中心', icon: '◉', show: role('admin', 'legal', 'publisher') },
  { path: '/settings', name: '接入与模型配置', icon: '⌘', show: role('admin'), section: '系统管理' },
  { path: '/operations', name: '运行与审计', icon: '◷', show: role('admin') },
].filter(p => p.show));
const title = computed(() => route.path.startsWith('/contracts/') ? '合同审核详情' : pages.value.find(p => p.path === route.path)?.name || '合同工作台');
async function signIn() { loading.value = true; error.value = ''; try { Object.assign(session, await api('/auth/login', { method: 'POST', body: login.value, quiet: true })); login.value.password = ''; } catch (e) { error.value = e.message; } finally { loading.value = false; } }
async function signOut() { await api('/auth/logout', { method: 'POST' }); await loadSession(); router.push('/'); }
onMounted(() => loadSession().catch(e => { error.value = e.message; }));
</script>

<template>
  <div v-if="!session.ready" class="startup">{{ error || '正在连接法律工作台…' }}</div>
  <div v-else-if="!session.user" class="login-shell">
    <div class="login-story"><div class="brand-mark">L<span>·</span>A</div><div class="eyebrow">LEGAL AGENT / V1.0</div><h1>让法务判断，<br>有据可循。</h1><p>合同预审 · 证据核查 · 人工复核</p><div class="login-note">每份原件都被保留<br>每条意见都有依据<br>每次结论绑定版本</div></div>
    <form class="login-card" @submit.prevent="signIn"><span class="eyebrow">公司法务工作空间</span><h2>登录合同预审工作台</h2><p class="muted">使用管理员分配的账号，继续处理合同。</p><label>账号<input v-model="login.username" autocomplete="username" required placeholder="请输入账号" /></label><label>密码<input v-model="login.password" type="password" autocomplete="current-password" required placeholder="请输入密码" /></label><p v-if="error" class="error-text" role="alert">{{ error }}</p><button class="primary wide" :disabled="loading">{{ loading ? '正在登录…' : '登录工作台 →' }}</button><small>AI 提供辅助意见，由法务确认最终结论。</small></form>
  </div>
  <div v-else class="app-shell">
    <aside class="sidebar"><router-link to="/" class="brand"><b class="brand-icon">L<span>·</span>A</b><div>法律 Agent<small>合同预审工作台</small></div></router-link><nav><template v-for="p in pages" :key="p.path"><div v-if="p.section" class="nav-section">{{ p.section }}</div><router-link :to="p.path" :class="{ active: p.path === '/' ? route.path === '/' || route.path.startsWith('/contracts/') : route.path === p.path }"><span>{{ p.icon }}</span>{{ p.name }}</router-link></template></nav><div class="sidebar-foot"><div class="status-dot"></div>本机试点 · V1.0<p>AI 处理完成 ≠ 法务同意</p></div></aside>
    <div class="main-shell"><header class="topbar"><span>工作空间 <b>/</b> {{ title }}</span><div class="user-bar"><span class="avatar">{{ session.user.displayName.slice(0, 1) }}</span><span>{{ session.user.displayName }}</span><button class="text-btn" @click="signOut">退出</button></div></header><main><router-view /></main><footer>合同内容按权限访问 · 正式规则经法务发布后生效</footer></div>
  </div>
</template>
