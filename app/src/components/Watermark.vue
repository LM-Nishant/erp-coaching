<template>
  <div class="wm" :style="style" aria-hidden="true" />
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

const props = defineProps<{ text: string }>();

// Dynamic watermark: who is viewing and when, tiled over the content and drifting every few seconds so it cannot be
// cropped or blurred out of a screenshot or recording. White text with a dark outline shows on light and dark content.
const FONT_PX = 14;
const LINE_PX = 18;
const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const now = ref(new Date());
const offset = ref({ x: 0, y: 0 });

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const tile = computed(() => {
  const lines = [props.text, fmt.format(now.value)].filter(Boolean);
  const w = Math.max(240, Math.round(Math.max(...lines.map((l) => l.length)) * FONT_PX * 0.6) + 48);
  const h = Math.round(w * 0.55);
  const text = lines
    .map(
      (l, i) =>
        `<text x="${w / 2}" y="${h / 2 + (i - (lines.length - 1) / 2) * LINE_PX}">${escape(l)}</text>`,
    )
    .join('');
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
    `<g transform="rotate(-24 ${w / 2} ${h / 2})" font-family="-apple-system,Roboto,'Segoe UI',sans-serif" ` +
    `font-size="${FONT_PX}" font-weight="600" text-anchor="middle" dominant-baseline="middle" ` +
    `fill="rgba(255,255,255,0.5)" stroke="rgba(0,0,0,0.3)" stroke-width="0.75" paint-order="stroke">` +
    `${text}</g></svg>`;
  return { w, h, url: `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")` };
});

const style = computed(() => ({
  backgroundImage: tile.value.url,
  backgroundPosition: `${offset.value.x}px ${offset.value.y}px`,
}));

let clock: ReturnType<typeof setInterval> | undefined;
let drift: ReturnType<typeof setInterval> | undefined;
const move = () =>
  (offset.value = {
    x: Math.round(Math.random() * tile.value.w),
    y: Math.round(Math.random() * tile.value.h),
  });
onMounted(() => {
  move();
  drift = setInterval(move, 6000);
  clock = setInterval(() => (now.value = new Date()), 15_000);
});
onBeforeUnmount(() => {
  clearInterval(drift);
  clearInterval(clock);
});
</script>

<style scoped>
.wm {
  position: absolute;
  inset: 0;
  z-index: 10;
  pointer-events: none;
  user-select: none;
  background-repeat: repeat;
  transition: background-position 1.5s ease;
}
@media (prefers-reduced-motion: reduce) {
  .wm {
    transition: none;
  }
}
</style>
