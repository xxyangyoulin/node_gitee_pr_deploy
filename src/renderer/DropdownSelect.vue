<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps<{
  modelValue: string | number
  options: Array<{ value: string | number; label: string }>
  disabled?: boolean
}>()
const emit = defineEmits<{ (e: 'update:modelValue', value: string | number): void }>()

const root = ref<HTMLElement | null>(null)
const open = ref(false)
const display = computed(() => props.options.find((option) => option.value === props.modelValue)?.label ?? String(props.modelValue ?? ''))

function onDocMouseDown(event: MouseEvent) {
  if (root.value && !root.value.contains(event.target as Node)) open.value = false
}

function onEsc(event: KeyboardEvent) {
  if (event.key === 'Escape') open.value = false
}

function onScrollCapture(event: Event) {
  if (root.value && !root.value.contains(event.target as Node)) open.value = false
}

function choose(value: string | number) {
  emit('update:modelValue', value)
  open.value = false
}

watch(open, (value) => {
  if (value) {
    document.addEventListener('mousedown', onDocMouseDown)
    document.addEventListener('keydown', onEsc)
    window.addEventListener('scroll', onScrollCapture, true)
  } else {
    document.removeEventListener('mousedown', onDocMouseDown)
    document.removeEventListener('keydown', onEsc)
    window.removeEventListener('scroll', onScrollCapture, true)
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocMouseDown)
  document.removeEventListener('keydown', onEsc)
  window.removeEventListener('scroll', onScrollCapture, true)
})
</script>

<template>
  <span ref="root" class="dropdown">
    <button type="button" class="dropdown-toggle" :disabled="disabled" @click="open = !open">
      <span class="dropdown-label">{{ display }}</span>
      <span class="dropdown-arrow">▾</span>
    </button>
    <div v-if="open" class="dropdown-menu">
      <button v-for="option in options" :key="option.value" type="button" :class="{ active: option.value === modelValue }" @click="choose(option.value)">{{ option.label }}</button>
    </div>
  </span>
</template>
