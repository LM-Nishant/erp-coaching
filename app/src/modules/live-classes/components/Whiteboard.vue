<template>
  <div class="wb">
    <canvas
      ref="canvas"
      :class="{ editable }"
      @pointerdown="down"
      @pointermove="move"
      @pointerup="up"
      @pointercancel="up"
      @pointerleave="up"
    />
    <div v-if="editable" class="tools">
      <button
        v-for="c in colors"
        :key="c"
        class="swatch"
        :class="{ active: tool === 'pen' && color === c }"
        :style="{ background: c }"
        :aria-label="`Pen ${c}`"
        @click="pick(c)"
      />
      <button :class="{ active: tool === 'eraser' }" @click="tool = 'eraser'">Eraser</button>
      <button @click="emit('undo')">Undo</button>
      <button @click="emit('clear')">Clear</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { WhiteboardStroke } from '@erp/shared';

const props = defineProps<{ strokes: WhiteboardStroke[]; editable?: boolean }>();
const emit = defineEmits<{ stroke: [WhiteboardStroke]; undo: []; clear: [] }>();
defineExpose({ canvas: () => canvas.value });

const W = 1280;
const H = 720;
// Server limit: 4000 numbers (2000 points) per stroke.
const MAX_COORDS = 4000;
const colors = ['#111111', '#d32f2f', '#1976d2', '#388e3c', '#f57c00'];
const canvas = ref<HTMLCanvasElement | null>(null);
const tool = ref<'pen' | 'eraser'>('pen');
const color = ref(colors[0]);
let current: WhiteboardStroke | null = null;

function pick(c: string) {
  tool.value = 'pen';
  color.value = c;
}

function drawStroke(ctx: CanvasRenderingContext2D, s: WhiteboardStroke) {
  if (s.points.length < 2) return;
  ctx.save();
  ctx.globalCompositeOperation = s.tool === 'eraser' ? 'destination-out' : 'source-over';
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.width * (W / 1280);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(s.points[0] * W, s.points[1] * H);
  if (s.points.length === 2) ctx.lineTo(s.points[0] * W + 0.1, s.points[1] * H);
  for (let i = 2; i < s.points.length; i += 2) ctx.lineTo(s.points[i] * W, s.points[i + 1] * H);
  ctx.stroke();
  ctx.restore();
}

function redraw() {
  const ctx = canvas.value?.getContext('2d');
  if (!ctx) return;
  // Strokes are drawn onto a transparent layer (so the eraser works), then composited on white.
  ctx.clearRect(0, 0, W, H);
  for (const s of props.strokes) drawStroke(ctx, s);
  if (current) drawStroke(ctx, current);
  ctx.save();
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
}

function point(e: PointerEvent): [number, number] {
  const r = canvas.value!.getBoundingClientRect();
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return [clamp((e.clientX - r.left) / r.width), clamp((e.clientY - r.top) / r.height)];
}

function down(e: PointerEvent) {
  if (!props.editable) return;
  canvas.value!.setPointerCapture(e.pointerId);
  const [x, y] = point(e);
  current = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    tool: tool.value,
    color: color.value,
    width: tool.value === 'eraser' ? 36 : 5,
    points: [x, y],
  };
  redraw();
}

function move(e: PointerEvent) {
  if (!current) return;
  const [x, y] = point(e);
  const n = current.points.length;
  if (Math.hypot(x - current.points[n - 2], y - current.points[n - 1]) < 0.002) return;
  current.points.push(x, y);
  if (current.points.length >= MAX_COORDS) return up();
  redraw();
}

function up() {
  if (!current) return;
  const s = { ...current, points: current.points.map((v) => Math.round(v * 10000) / 10000) };
  current = null;
  emit('stroke', s);
}

let raf = 0;
const schedule = () => {
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(redraw);
};
watch(() => [props.strokes.length, props.strokes[props.strokes.length - 1]?.id], schedule);

onMounted(() => {
  canvas.value!.width = W;
  canvas.value!.height = H;
  redraw();
});
onBeforeUnmount(() => cancelAnimationFrame(raf));
</script>

<style scoped>
.wb {
  position: relative;
  width: 100%;
}
canvas {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 9;
  background: #fff;
  border: 1px solid var(--ion-color-light-shade, #ddd);
  border-radius: 8px;
  touch-action: none;
}
canvas.editable {
  cursor: crosshair;
}
.tools {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 0;
}
.tools button {
  border: 1px solid var(--ion-color-medium);
  background: var(--ion-background-color, #fff);
  color: var(--ion-text-color, #111);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 13px;
}
.tools .swatch {
  width: 26px;
  height: 26px;
  padding: 0;
  border-radius: 50%;
}
.tools .active {
  outline: 2px solid var(--ion-color-primary);
  outline-offset: 1px;
}
</style>
