<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'

export type DropdownAction = { label: string; onAction: () => void }
export type DropdownOption = { value: string | number; label: string; actionLabel?: string; onAction?: () => void; actions?: DropdownAction[] }

const props = defineProps<{
  modelValue: string | number
  options: DropdownOption[]
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

function runAction(action: DropdownAction) {
  open.value = false
  action.onAction()
}

function optionActions(option: DropdownOption): DropdownAction[] {
  const list = [...(option.actions ?? [])]
  if (option.actionLabel && option.onAction) list.push({ label: option.actionLabel, onAction: option.onAction })
  return list
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
      <div v-for="option in options" :key="option.value" :class="['dropdown-option', { active: option.value === modelValue }]"><button type="button" class="dropdown-option-label" @click="choose(option.value)">{{ option.label }}</button><button v-for="(action, i) in optionActions(option)" :key="i" type="button" class="dropdown-option-action" @click.stop="runAction(action)">{{ action.label }}</button></div>
    </div>
  </span>
</template>
