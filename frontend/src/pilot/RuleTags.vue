<script setup>
import { ref } from 'vue';
const props = defineProps({ modelValue: { type: Array, default: () => [] }, label: { type: String, default: '标签' } });
const emit = defineEmits(['update:modelValue']);
const text = ref('');
function add() { const value = text.value.trim(); if (value && !props.modelValue.includes(value)) emit('update:modelValue', [...props.modelValue, value]); text.value = ''; }
</script>
<template><div class="rule-tags"><div v-if="modelValue.length" class="rule-chips"><span v-for="(tag, i) in modelValue" :key="i">{{ tag }}<button type="button" :aria-label="`移除${label}：${tag}`" @click="emit('update:modelValue', modelValue.filter((_, n) => n !== i))">×</button></span></div><div class="rule-tag-entry"><input v-model="text" :aria-label="`新增${label}`" maxlength="100" placeholder="输入后点添加或按回车" @keydown.enter.prevent="add" @blur="add" /><button type="button" :disabled="!text.trim()" @click="add">添加</button></div></div></template>
