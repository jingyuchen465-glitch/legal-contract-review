<script setup>
defineProps({
  run: { type: Object, required: true },
  classificationName: { type: String, default: '' },
  classificationConfirmed: { type: Boolean, default: false },
  rulesAvailable: { type: Boolean, default: false },
  canRerun: { type: Boolean, default: false },
  canConfirm: { type: Boolean, default: false },
  canSupplement: { type: Boolean, default: false },
  canTry: { type: Boolean, default: false },
  canViewRules: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
});
defineEmits(['classification', 'trial', 'background', 'rerun']);
</script>

<template>
  <section class="notice review-notice" :class="{ danger: run.status === 'failed' }" :role="run.status === 'failed' ? 'alert' : 'status'">
    <template v-if="run.error_code === 'SPECIALTY_NOT_ENABLED'">
      <strong>本次记录尚未执行专项审查</strong>
      <p><template v-if="classificationName">当前识别为「{{ classificationName }}」。</template>此记录生成时，该类型专项审查尚未启用，本次仅完成文件解析与分类。</p>
      <p v-if="rulesAvailable">当前分类已有正式规则。请重新预审，以新规则生成检查结果；本次记录会保留作追溯。</p>
      <p v-else>{{ canTry ? '现在可以使用内置示例规则试审，结果供法务核对；正式预审仍需发布法务确认的规则。' : '请法务核实分类，并发布适用的专项规则后重新预审。' }}</p>
      <button v-if="canConfirm && !classificationConfirmed" type="button" @click="$emit('classification')">核实合同分类</button>
    </template>
    <template v-else-if="run.error_code === 'NO_PUBLISHED_RULES'">
      <strong>{{ rulesAvailable ? '该类型规则已发布，请重新预审' : '该合同类型还没有已发布的专项审查规则' }}</strong>
      <p v-if="rulesAvailable">本次记录创建时尚无适用规则，因此没有执行条款审查。新规则只用于新建的预审记录，重新预审后即可查看检查结果。</p>
      <p v-else>本次尚未执行条款风险审查。{{ canTry ? '可先使用内置示例规则试审，核对检查项及模型效果。示例试审不能直接确认最终结论。' : '请规则发布人在「分类与规则中心」审核并发布适用规则，然后重新预审。' }}</p>
      <button v-if="canConfirm && !classificationConfirmed" type="button" @click="$emit('classification')">核实合同分类</button>
    </template>
    <template v-else-if="run.error_code === 'BACKGROUND_REQUIRED'">
      <strong>合同文件已收取，请补充业务背景以继续预审</strong>
      <p>填写我方主体、交易立场和交易目的后，即可重新预审。</p>
      <button v-if="canSupplement" type="button" @click="$emit('background')">补充业务背景</button>
    </template>
    <template v-else-if="['MODEL_SNAPSHOT_CHANGED', 'MODEL_SNAPSHOT_MISSING'].includes(run.error_code)">
      <strong>模型配置已变化，本次预审已暂停</strong>
      <p>为保证审查结果可追溯，系统不会混用模型配置。请确认当前模型后点击“正式重新预审”。</p>
    </template>
    <template v-else>
      <strong>{{ run.status === 'failed' ? '预审未完成' : '预审需要人工处理' }}</strong>
      <p>{{ run.error_message }}</p>
    </template>
    <div v-if="['SPECIALTY_NOT_ENABLED', 'NO_PUBLISHED_RULES'].includes(run.error_code)" class="next-actions">
      <button v-if="rulesAvailable && canRerun" type="button" class="primary" :disabled="busy" @click="$emit('rerun')">{{ busy ? '正在创建预审…' : '使用已发布规则重新预审' }}</button>
      <button v-else-if="!rulesAvailable && canTry" type="button" class="primary" :disabled="busy" @click="$emit('trial')">{{ busy ? '正在创建试审…' : '使用示例规则试审' }}</button>
      <router-link v-if="!rulesAvailable && canViewRules" to="/rules">查看审查规则 →</router-link>
    </div>
    <details v-if="run.error_code"><summary>查看技术信息</summary><code>{{ run.error_code }}</code></details>
  </section>
</template>

<style scoped>
.notice.review-notice { padding: 18px 20px; border: 1px solid #e6d2a7; border-radius: 8px; background: #fff9ed; color: #6b4f25; font-size: 13px; line-height: 1.8; }
.notice.review-notice.danger { background: #fff2f0; color: #9c4034; border-color: #ecc9c2; }
.review-notice strong { font-size: 14px; }
.review-notice p { margin: 6px 0; }
.review-notice button { margin-top: 8px; }
.next-actions { display: flex; gap: 16px; flex-wrap: wrap; align-items: center; margin-top: 6px; }
.review-notice details { margin-top: 10px; font-size: 11px; opacity: .8; }
.review-notice summary { cursor: pointer; width: fit-content; }
.review-notice code { display: block; margin-top: 6px; overflow-wrap: anywhere; }
</style>
