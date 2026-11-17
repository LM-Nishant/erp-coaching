<template>
  <ion-header>
    <ion-toolbar>
      <ion-buttons slot="start">
        <ion-button @click="cancel">Cancel</ion-button>
      </ion-buttons>
      <ion-title>Crop page</ion-title>
      <ion-buttons slot="end">
        <ion-button :strong="true" :disabled="!loaded || busy" @click="confirm">Use page</ion-button>
      </ion-buttons>
    </ion-toolbar>
  </ion-header>
  <ion-content class="ion-padding">
    <div class="preview">
      <canvas ref="canvas" />
    </div>
    <ion-list lines="none">
      <ion-item>
        <ion-range
          :value="horizontal"
          label="Left / right"
          label-placement="stacked"
          :dual-knobs="true"
          :min="0"
          :max="100"
          @ion-input="onHorizontal"
        />
      </ion-item>
      <ion-item>
        <ion-range
          :value="vertical"
          label="Top / bottom"
          label-placement="stacked"
          :dual-knobs="true"
          :min="0"
          :max="100"
          @ion-input="onVertical"
        />
      </ion-item>
    </ion-list>
    <div class="tools">
      <ion-button fill="outline" size="small" @click="rotate(-90)">
        <ion-icon slot="start" :icon="refreshOutline" class="flip" />Rotate left
      </ion-button>
      <ion-button fill="outline" size="small" @click="rotate(90)">
        <ion-icon slot="start" :icon="refreshOutline" />Rotate right
      </ion-button>
      <ion-button fill="clear" size="small" @click="reset">Reset</ion-button>
    </div>
  </ion-content>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonList,
  IonRange,
  IonTitle,
  IonToolbar,
  modalController,
  type RangeCustomEvent,
} from '@ionic/vue';
import { refreshOutline } from 'ionicons/icons';
import { toastError } from '@/core/toast';

interface DualValue {
  lower: number;
  upper: number;
}

const props = defineProps<{ file: Blob }>();

/** Longest edge of the produced JPEG; keeps uploads small while staying legible. */
const MAX_EDGE = 2200;
const MIN_SPAN = 10;

const canvas = ref<HTMLCanvasElement | null>(null);
const horizontal = ref<DualValue>({ lower: 0, upper: 100 });
const vertical = ref<DualValue>({ lower: 0, upper: 100 });
const rotation = ref(0);
const loaded = ref(false);
const busy = ref(false);
let img: HTMLImageElement | null = null;
const objectUrl = URL.createObjectURL(props.file);

function clampSpan(v: DualValue): DualValue {
  if (v.upper - v.lower >= MIN_SPAN) return v;
  return v.upper >= 100
    ? { lower: 100 - MIN_SPAN, upper: 100 }
    : { lower: v.lower, upper: v.lower + MIN_SPAN };
}

function onHorizontal(ev: RangeCustomEvent) {
  horizontal.value = clampSpan(ev.detail.value as DualValue);
}
function onVertical(ev: RangeCustomEvent) {
  vertical.value = clampSpan(ev.detail.value as DualValue);
}

function rotate(deg: number) {
  rotation.value = (rotation.value + deg + 360) % 360;
}

function reset() {
  horizontal.value = { lower: 0, upper: 100 };
  vertical.value = { lower: 0, upper: 100 };
  rotation.value = 0;
}

/** The full image rotated by `rotation`, scaled so its longest edge is at most `maxEdge`. */
function rotatedSource(maxEdge: number): HTMLCanvasElement {
  const image = img!;
  const scale = Math.min(1, maxEdge / Math.max(image.naturalWidth, image.naturalHeight));
  const w = Math.round(image.naturalWidth * scale);
  const h = Math.round(image.naturalHeight * scale);
  const swap = rotation.value % 180 !== 0;
  const c = document.createElement('canvas');
  c.width = swap ? h : w;
  c.height = swap ? w : h;
  const ctx = c.getContext('2d')!;
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((rotation.value * Math.PI) / 180);
  ctx.drawImage(image, -w / 2, -h / 2, w, h);
  return c;
}

function cropRect(w: number, h: number) {
  const x = (horizontal.value.lower / 100) * w;
  const y = (vertical.value.lower / 100) * h;
  return {
    x,
    y,
    w: ((horizontal.value.upper - horizontal.value.lower) / 100) * w,
    h: ((vertical.value.upper - vertical.value.lower) / 100) * h,
  };
}

function draw() {
  const c = canvas.value;
  if (!c || !img) return;
  const src = rotatedSource(1000);
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext('2d')!;
  ctx.drawImage(src, 0, 0);
  const r = cropRect(c.width, c.height);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(0, 0, c.width, r.y);
  ctx.fillRect(0, r.y + r.h, c.width, c.height - r.y - r.h);
  ctx.fillRect(0, r.y, r.x, r.h);
  ctx.fillRect(r.x + r.w, r.y, c.width - r.x - r.w, r.h);
  ctx.strokeStyle = '#3880ff';
  ctx.lineWidth = Math.max(2, c.width / 300);
  ctx.strokeRect(r.x, r.y, r.w, r.h);
}

watch([horizontal, vertical, rotation], draw, { deep: true });

onMounted(() => {
  const image = new Image();
  image.onload = () => {
    img = image;
    loaded.value = true;
    draw();
  };
  image.onerror = () => {
    void toastError(new Error('Could not open this image'));
    void modalController.dismiss(null, 'cancel');
  };
  image.src = objectUrl;
});

onBeforeUnmount(() => URL.revokeObjectURL(objectUrl));

function cancel() {
  void modalController.dismiss(null, 'cancel');
}

async function confirm() {
  if (!img) return;
  busy.value = true;
  try {
    const src = rotatedSource(MAX_EDGE);
    const r = cropRect(src.width, src.height);
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(r.w));
    out.height = Math.max(1, Math.round(r.h));
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(src, r.x, r.y, r.w, r.h, 0, 0, out.width, out.height);
    const blob = await new Promise<Blob | null>((resolve) => out.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) throw new Error('Could not process the image');
    await modalController.dismiss(blob, 'confirm');
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.preview {
  display: flex;
  justify-content: center;
  background: var(--ion-color-light);
  border-radius: 8px;
  padding: 8px;
}
.preview canvas {
  max-width: 100%;
  max-height: 55vh;
  object-fit: contain;
}
.tools {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: center;
}
.flip {
  transform: scaleX(-1);
}
</style>
