<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import lottie, { type AnimationItem } from 'lottie-web'
import animationData from './git-logo.json'

const container = ref<HTMLElement | null>(null)
let anim: AnimationItem | null = null

onMounted(() => {
  anim = lottie.loadAnimation({
    container: container.value!,
    renderer: 'svg',
    loop: true,
    autoplay: true,
    animationData: JSON.parse(JSON.stringify(animationData)),
  })
})

onBeforeUnmount(() => {
  anim?.destroy()
  anim = null
})
</script>

<template>
  <div ref="container" class="loading-anim"></div>
</template>
