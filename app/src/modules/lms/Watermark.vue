<template>
  <div class="wm" :style="{ top: pos.top + '%', left: pos.left + '%' }" aria-hidden="true">{{ text }}</div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, reactive } from 'vue';

defineProps<{ text: string }>();

// Moves every few seconds so it cannot be cropped or blurred out of a screen recording.
const pos = reactive({ top: 10, left: 10 });
let timer: ReturnType<typeof setInterval> | undefined;
const move = () => Object.assign(pos, { top: 5 + Math.random() * 80, left: 5 + Math.random() * 55 });
onMounted(() => {
  move();
  timer = setInterval(move, 6000);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<style scoped>
.wm {
  position: absolute;
  pointer-events: none;
  user-select: none;
  z-index: 5;
  color: rgba(255, 255, 255, 0.55);
  text-shadow: 0 0 2px rgba(0, 0, 0, 0.6);
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  transition:
    top 1.5s ease,
    left 1.5s ease;
}
</style>
