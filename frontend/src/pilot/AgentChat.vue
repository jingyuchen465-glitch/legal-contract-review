<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { time } from './api';
import AgentQuestionCard from './AgentQuestionCard.vue';

// Vue presentation of the MUI X Chat default layout; existing session APIs stay in AgentReview.
const props = defineProps({
  modelValue: { type: String, default: '' },
  feedback: Boolean,
  messages: { type: Array, default: () => [] },
  visible: Boolean,
  hasSession: Boolean,
  readonly: Boolean,
  working: Boolean,
  busy: Boolean,
  canLearn: Boolean,
  question: { type: String, default: '' },
  pendingQuestion: Object,
});
const emit = defineEmits(['update:modelValue', 'update:feedback', 'send', 'stop', 'attach', 'answer']);
const feed = ref(), input = ref(), atBottom = ref(true), copied = ref(''), copyNotice = ref('');
let copyTimer;
const disabled = computed(() => props.readonly || !props.hasSession || props.working || props.busy);
const canSend = computed(() => !disabled.value && !!props.modelValue.trim());
const structuredQuestion = computed(() => props.question && props.pendingQuestion?.data?.questions?.length);
const suggestions = ['总结这份合同的主要风险', '哪些条款建议优先修改？', '给出可直接使用的修改建议'];
const placeholder = computed(() => !props.hasSession ? '开始审查后，可在这里继续沟通' : props.working ? 'Agent 正在审查，请稍候…' : props.question ? '补充上述信息，继续审查…' : '补充交易背景，或追问合同中的问题…');

function scrollToLatest() {
  if (feed.value) feed.value.scrollTop = feed.value.scrollHeight;
  atBottom.value = true;
}
function onScroll() {
  const el = feed.value;
  if (el) atBottom.value = el.scrollHeight - el.clientHeight - el.scrollTop < 64;
}
function resizeInput() {
  if (!input.value) return;
  input.value.style.height = 'auto';
  input.value.style.height = Math.min(input.value.scrollHeight, 168) + 'px';
}
function onKeydown(event) {
  if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  if (canSend.value) emit('send');
}
async function suggest(text) {
  emit('update:modelValue', text);
  await nextTick();
  input.value?.focus();
}
async function copyMessage(message) {
  clearTimeout(copyTimer);
  try {
    await navigator.clipboard.writeText(message.content);
    copied.value = message.id;
    copyNotice.value = '消息已复制';
  } catch {
    copyNotice.value = '复制失败，请选中消息文字后复制';
  }
  copyTimer = setTimeout(() => { copied.value = ''; copyNotice.value = ''; }, 2500);
}
watch(() => props.modelValue, resizeInput, { flush: 'post' });
watch(() => props.messages.map(m => m.id + ':' + m.content).join('\n'), async () => {
  const follow = atBottom.value;
  await nextTick();
  if (follow) scrollToLatest();
}, { flush: 'post' });
watch(() => props.visible, async visible => {
  if (!visible) return;
  await nextTick();
  if (atBottom.value) scrollToLatest();
  resizeInput();
});
watch(() => props.working, async () => { await nextTick(); if (atBottom.value) scrollToLatest(); });
onBeforeUnmount(() => clearTimeout(copyTimer));
</script>

<template>
  <div class="legal-chat" :class="{ 'is-answering': structuredQuestion }">
    <div v-show="visible" class="legal-chat-conversation">
      <div class="legal-chat-context"><span class="legal-chat-context-dot" aria-hidden="true"></span>合同审查助手<span>当前合同上下文</span></div>
      <div ref="feed" class="legal-chat-feed" role="log" aria-label="合同审查对话" aria-live="polite" aria-relevant="additions" tabindex="0" @scroll="onScroll">
        <div v-if="!messages.length" class="legal-chat-empty">
          <span class="legal-chat-welcome-icon" aria-hidden="true">✦</span>
          <h2>一起把合同看得更清楚</h2>
          <p>{{ hasSession ? '补充交易背景、追问风险，或讨论条款如何修改。' : '开始合同审查后，即可在这里补充背景、追问风险。' }}</p>
          <div v-if="hasSession && !working && !readonly" class="legal-chat-suggestions"><button v-for="text in suggestions" :key="text" type="button" :disabled="disabled" @click="suggest(text)">{{ text }}<span aria-hidden="true">↗</span></button></div>
        </div>
        <article v-for="m in messages" :key="m.id" class="legal-chat-message" :class="{ 'is-user': m.role === 'user' }" :aria-label="m.role === 'user' ? '法务 / 提交人' : '法律 Agent'">
          <span class="legal-chat-avatar" aria-hidden="true">
            <svg v-if="m.role === 'user'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="8" r="3.5" /><path d="M5 21v-2a7 7 0 0 1 14 0v2" /></svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" /><path d="m20 2 .6 1.4L22 4l-1.4.6L20 6l-.6-1.4L18 4l1.4-.6Z" /></svg>
          </span>
          <div class="legal-chat-message-body">
            <div class="legal-chat-author">{{ m.role === 'user' ? '法务 / 提交人' : '法律 Agent' }}<span v-if="m.kind === 'question'" class="legal-chat-question-tag">需要补充信息</span></div>
            <div class="legal-chat-bubble"><p>{{ m.content }}</p></div>
            <div class="legal-chat-message-meta"><time :datetime="m.created_at">{{ time(m.created_at) }}</time><button type="button" class="legal-chat-copy" :aria-label="copied === m.id ? '已复制消息' : '复制消息'" :title="copied === m.id ? '已复制' : '复制消息'" @click="copyMessage(m)"><svg v-if="copied === m.id" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m5 12 4 4L19 6" /></svg><svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M15 8V4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h4" /></svg></button></div>
          </div>
        </article>
        <div v-if="working" class="legal-chat-pending" role="status"><span class="legal-chat-typing" aria-hidden="true"><i></i><i></i><i></i></span>Agent 正在审查合同…</div>
      </div>
      <button v-if="!atBottom" type="button" class="legal-chat-latest" @click="scrollToLatest">↓ 回到最新消息</button>
    </div>

    <AgentQuestionCard v-if="structuredQuestion && !readonly" :question="pendingQuestion" :busy="busy || working" @answer="emit('answer', $event)" />
    <form v-else-if="!readonly" class="legal-chat-composer" @submit.prevent="canSend && emit('send')">
      <div v-if="question" class="legal-chat-question"><b>待补充信息</b><p>{{ question }}</p></div>
      <div class="legal-chat-input-box" :class="{ 'is-disabled': disabled }">
        <label class="sr-only" for="agent-message">补充信息或追问</label>
        <textarea id="agent-message" ref="input" :value="modelValue" rows="2" maxlength="20000" :placeholder="placeholder" :disabled="disabled" aria-describedby="legal-chat-hint" @input="emit('update:modelValue', $event.target.value)" @keydown="onKeydown" />
        <div class="legal-chat-toolbar">
          <div class="legal-chat-tools"><button class="legal-chat-attach" type="button" aria-label="补充合同材料" title="补充材料 / 新稿" :disabled="busy" @click="emit('attach')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="m8 12 6-6a3.5 3.5 0 0 1 5 5L10.5 20a5 5 0 0 1-7-7L12 4.5a2 2 0 0 1 3 3L7 15.5" /></svg></button><label v-if="canLearn" class="legal-chat-feedback"><input type="checkbox" :checked="feedback" :disabled="disabled" @change="emit('update:feedback', $event.target.checked)" />可复用的法务反馈</label></div>
          <button v-if="working" type="button" class="legal-chat-stop" :disabled="busy" @click="emit('stop')"><svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>停止</button>
          <button v-else class="legal-chat-send" type="submit" :disabled="!canSend" :aria-label="question ? '补充并继续' : '发送'" :title="question ? '补充并继续' : '发送消息（Enter）'"><span>{{ busy ? '发送中' : question ? '补充并继续' : '发送' }}</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 7-7 7 7M12 5v15" /></svg></button>
        </div>
      </div>
      <div id="legal-chat-hint" class="legal-chat-hint"><span role="status">{{ copyNotice || (working ? '正在结合合同与补充信息审查' : 'Enter 发送 · Shift + Enter 换行') }}</span><span>AI 辅助 · 法务判断</span></div>
    </form>
  </div>
</template>

<style scoped>
.legal-chat{--chat-primary:#1976d2;--chat-text:#202124;--chat-muted:#707782;color:var(--chat-text);background:#fff;min-width:0}
.legal-chat-conversation{position:relative}
.legal-chat-context{display:flex;align-items:center;gap:7px;padding:15px 22px 5px;font-size:12px;font-weight:600;color:#454d59}
.legal-chat-context>span:last-child{margin-left:auto;font-size:10px;font-weight:400;color:#9299a3}
.legal-chat-context-dot{width:6px;height:6px;background:#1976d2;border-radius:50%}
.legal-chat-feed{height:clamp(350px,54vh,680px);overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#d6dbe2 transparent;padding:24px 22px 12px;outline-offset:-3px}
.is-answering .legal-chat-feed{height:clamp(160px,24vh,260px)}
.legal-chat-message{display:flex;align-items:flex-start;gap:10px;margin:0 0 20px;min-width:0}
.legal-chat-avatar{display:flex;align-items:center;justify-content:center;width:32px;height:32px;flex:none;border-radius:50%;color:#1976d2;background:#eaf3fc;border:1px solid #dbeafa}
.legal-chat-avatar svg{width:20px;height:20px}
.legal-chat-message-body{max-width:calc(100% - 42px);min-width:0}
.legal-chat-author{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:24px;margin:0 0 5px;font-size:11px;font-weight:600;color:#525b68}
.legal-chat-question-tag{padding:1px 6px;border-radius:4px;background:#fff5df;color:#926416;font-size:10px;font-weight:400}
.legal-chat-bubble{padding:13px 16px;background:#f3f5f7;border:1px solid #eef0f3;border-radius:0 14px 14px 14px}
.legal-chat-bubble p{margin:0;font-size:13px;line-height:1.85;white-space:pre-wrap;overflow-wrap:anywhere}
.legal-chat-message-meta{display:flex;align-items:center;gap:8px;margin-top:5px;min-height:24px;font-size:10px;color:#9299a3}
.legal-chat-copy{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:5px;border:0;border-radius:5px;background:transparent;color:#9098a3}
.legal-chat-copy:hover{color:#1976d2;background:#edf4fc}
.legal-chat-copy svg{width:15px;height:15px}
.legal-chat-message.is-user{flex-direction:row-reverse;margin-left:28px}
.is-user .legal-chat-avatar{color:#626d7e;background:#f1f3f6;border-color:#e8ebef}
.is-user .legal-chat-message-body{display:flex;flex-direction:column;align-items:flex-end}
.is-user .legal-chat-author{justify-content:flex-end}
.is-user .legal-chat-bubble{background:#e8f1fc;border-color:#dfebfa;border-radius:14px 0 14px 14px;color:#173c69}
.is-user .legal-chat-message-meta{justify-content:flex-end}
.legal-chat-latest{position:absolute;bottom:12px;left:50%;transform:translateX(-50%);padding:7px 13px;border:1px solid #dce4ef;border-radius:20px;background:white;color:#1976d2;font-size:11px;box-shadow:0 3px 12px #1d365416;white-space:nowrap}
.legal-chat-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:300px;text-align:center;padding:24px 5px}
.legal-chat-welcome-icon{display:grid;place-items:center;width:48px;height:48px;margin-bottom:18px;background:#edf5ff;border:1px solid #dceafb;border-radius:14px;color:#1976d2;font-size:29px}
.legal-chat-empty h2{margin:0 0 10px;font-size:17px;font-weight:600;color:#303b4b}
.legal-chat-empty p{font-size:12px;color:#818996;line-height:1.8;margin:0 0 22px}
.legal-chat-suggestions{display:flex;flex-direction:column;gap:8px;max-width:320px;width:100%}
.legal-chat-suggestions button{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:11px 13px;text-align:left;border:1px solid #e5e9ef;border-radius:9px;color:#5a6471;font-size:12px;background:#fff}
.legal-chat-suggestions button:hover{background:#f7faff;border-color:#a9c9ee;color:#1976d2}
.legal-chat-pending{display:flex;align-items:center;gap:10px;margin:0 0 16px 42px;color:#808996;font-size:12px}
.legal-chat-typing{display:flex;gap:4px;padding:12px;background:#f3f5f7;border-radius:12px}
.legal-chat-typing i{width:4px;height:4px;border-radius:50%;background:#879aaf;animation:chat-typing 1.4s infinite}
.legal-chat-typing i:nth-child(2){animation-delay:.16s}.legal-chat-typing i:nth-child(3){animation-delay:.32s}
.legal-chat-composer{padding:12px 18px 10px;background:#fff;border-top:1px solid #edf0f3}
.legal-chat-input-box{border:1px solid #dce1e8;border-radius:12px;padding:12px 12px 9px;transition:border-color .15s,box-shadow .15s;background:#fff}
.legal-chat-input-box:focus-within{border-color:#1976d2;box-shadow:0 0 0 1px #1976d2}
.legal-chat-input-box.is-disabled{background:#fafbfc}
.legal-chat-input-box textarea{display:block;width:100%;min-height:60px;max-height:168px;padding:0 2px 8px;border:0;border-radius:0;background:transparent;resize:none;outline:none;box-shadow:none;color:#273444;font-size:13px;line-height:1.8}
.legal-chat-input-box textarea::placeholder{color:#929aa6}.legal-chat-input-box textarea:disabled{cursor:not-allowed}
.legal-chat-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px}
.legal-chat-tools{display:flex;align-items:center;gap:8px;min-width:0}
.legal-chat-attach{display:grid;place-items:center;flex:none;width:30px;height:32px;padding:5px;border:0;border-radius:6px;background:transparent;color:#7b8593}
.legal-chat-attach:hover{color:#1976d2;background:#eef5fc}
.legal-chat-attach svg{width:19px;height:19px}
.legal-chat-feedback{display:flex;flex-direction:row;align-items:center;gap:5px;margin:0;font-size:11px;color:#808996;cursor:pointer}
.legal-chat-feedback input{width:13px;height:13px;margin:0;accent-color:#1976d2}
.legal-chat-send,.legal-chat-stop{display:inline-flex;align-items:center;justify-content:center;flex:none;gap:6px;min-height:34px;padding:7px 12px;border:1px solid #1976d2;border-radius:8px;background:#1976d2;color:white;font-size:12px;box-shadow:0 2px 5px #1976d219}
.legal-chat-send:hover{background:#1565c0;border-color:#1565c0}
.legal-chat-send:disabled{background:#edf0f4;border-color:#edf0f4;color:#a4adba;opacity:1;box-shadow:none}
.legal-chat-send svg,.legal-chat-stop svg{width:17px;height:17px}
.legal-chat-stop{background:white;border-color:#dce1e8;color:#687483;box-shadow:none}
.legal-chat-stop:hover{background:#f3f5f7;border-color:#a6b4c5}
.legal-chat-hint{display:flex;justify-content:space-between;gap:10px;margin:9px 2px 0;color:#a0a7b1;font-size:10px;line-height:1.6}
.legal-chat-question{padding:11px 13px;margin:0 0 12px;border-left:3px solid #edb556;border-radius:3px 7px 7px 3px;background:#fff9ed;font-size:12px;color:#88652c}
.legal-chat-question b{font-size:11px}.legal-chat-question p{margin:4px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.7}
@keyframes chat-typing{0%,60%,100%{opacity:.35;transform:translateY(0)}30%{opacity:1;transform:translateY(-3px)}}
@media(max-width:520px){.legal-chat-feed{padding:18px 12px 8px;height:clamp(320px,52vh,550px)}.legal-chat-context{padding:13px 12px 3px}.legal-chat-avatar{width:27px;height:27px}.legal-chat-avatar svg{width:17px;height:17px}.legal-chat-message{gap:7px}.legal-chat-message-body{max-width:calc(100% - 34px)}.legal-chat-message.is-user{margin-left:12px}.legal-chat-bubble{padding:11px 12px}.legal-chat-composer{padding:10px}.legal-chat-feedback{font-size:10px}.legal-chat-tools{gap:3px}.legal-chat-input-box{padding:10px 9px 8px}.legal-chat-hint{font-size:9px}.legal-chat-context>span:last-child{font-size:9px}.legal-chat-send{padding:7px 9px;gap:3px}}
@media(prefers-reduced-motion:reduce){.legal-chat-typing i{animation:none}.legal-chat-input-box{transition:none}}
</style>
