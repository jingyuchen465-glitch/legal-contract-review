import { reactive } from 'vue';
import { ElMessage } from 'element-plus/es/components/message/index.mjs';
export const session = reactive({ user: null, csrf: '', ready: false });
export const role = (...roles) => !!session.user && (session.user.roles.includes('admin') || session.user.roles.some(r => roles.includes(r)));
export async function api(path, options = {}) {
  const isForm = options.body instanceof FormData;
  try {
    const response = await fetch(`/api${path}`, { credentials: 'same-origin', ...options, headers: { ...(isForm ? {} : options.body ? { 'Content-Type': 'application/json' } : {}), 'X-CSRF-Token': session.csrf, ...options.headers }, body: options.body && !isForm ? JSON.stringify(options.body) : options.body });
    const result = await response.json();
    if (!response.ok) { if (response.status === 401 && !path.startsWith('/auth')) session.user = null; const error = new Error(result.message || '请求失败'); error.code = result.code; throw error; }
    return result;
  } catch (e) { if (!options.quiet) ElMessage.error(e.message || '网络连接失败'); throw e; }
}
export async function loadSession() { Object.assign(session, await api('/auth/session')); session.ready = true; }
export const time = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
export const labels = { queued: '排队中', running: '处理中', finalizing: '正在保存结果', waiting_input: '待补充 / 人工处理', completed: 'AI 预审完成', failed: '处理失败', cancelled: '已取消', pending_review: '待法务复核', in_review: '法务复核中', returned: '已退回修改', finalized: '已确认结论', archived: '已归档', pass: '符合', fail: '存在问题', uncertain: '无法判断', high: '高风险', medium: '中风险', low: '低风险', agree: '同意', conditional: '附条件同意', disagree: '不同意', draft: '草稿', pending: '待审核', published: '已发布', retired: '已停用', accept: '采纳', reject: '驳回', correct: '已修正', needs_information: '待补充', acknowledge: '已确认处理意见' };
export const label = value => labels[value] || value || '—';
