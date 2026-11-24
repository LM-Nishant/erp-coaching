<template>
  <div class="playback" role="group" :aria-label="t('lms.player.controls')">
    <ion-button fill="clear" size="small" :aria-label="t('lms.player.back10')" @click="skip(-10)">
      <ion-icon slot="icon-only" :icon="playBackOutline" />
    </ion-button>
    <ion-button fill="clear" size="small" :aria-label="t('lms.player.forward10')" @click="skip(10)">
      <ion-icon slot="icon-only" :icon="playForwardOutline" />
    </ion-button>
    <ion-select
      :value="rate"
      interface="popover"
      :label="t('lms.player.speed')"
      class="opt"
      @ion-change="rate = Number($event.detail.value)"
    >
      <ion-select-option v-for="r in RATES" :key="r" :value="r">{{ r }}×</ion-select-option>
    </ion-select>
    <ion-select
      v-if="qualities.length > 1"
      :value="quality"
      interface="popover"
      :label="t('lms.player.quality')"
      class="opt"
      @ion-change="quality = Number($event.detail.value)"
    >
      <ion-select-option :value="-1">{{ t('lms.player.auto') }}</ion-select-option>
      <ion-select-option v-for="q in [...qualities].reverse()" :key="q" :value="q"
        >{{ q }}p</ion-select-option
      >
    </ion-select>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { IonButton, IonIcon, IonSelect, IonSelectOption } from '@ionic/vue';
import { playBackOutline, playForwardOutline } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';

/**
 * Speed (remembered on the device), ±10 s and, for multi-quality HLS played through hls.js, the video quality
 * (also remembered, e.g. 360p to save data). Bind `quality` to `useVideoSource(...).quality`.
 */
const props = defineProps<{ video: HTMLVideoElement | null; qualities: number[] }>();
const quality = defineModel<number>('quality', { default: -1 });
const { t } = useI18n();

const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;
const RATE_KEY = 'erp.player.rate';
const QUALITY_KEY = 'erp.player.quality';

const stored = Number(localStorage.getItem(RATE_KEY));
const rate = ref<number>(RATES.includes(stored as (typeof RATES)[number]) ? stored : 1);
const storedQuality = Number(localStorage.getItem(QUALITY_KEY));
if (storedQuality > 0) quality.value = storedQuality;

function apply() {
  const v = props.video;
  if (!v) return;
  v.defaultPlaybackRate = rate.value;
  v.playbackRate = rate.value;
}

watch(rate, (r) => {
  localStorage.setItem(RATE_KEY, String(r));
  apply();
});
watch(quality, (q) => localStorage.setItem(QUALITY_KEY, String(q)));

// A new source resets the element's rate: apply it again once the media loads.
watch(
  () => props.video,
  (v, old) => {
    old?.removeEventListener('loadedmetadata', apply);
    v?.addEventListener('loadedmetadata', apply);
    apply();
  },
  { immediate: true },
);
onBeforeUnmount(() => props.video?.removeEventListener('loadedmetadata', apply));

function skip(seconds: number) {
  const v = props.video;
  if (!v) return;
  const end = Number.isFinite(v.duration) ? v.duration : Infinity;
  v.currentTime = Math.min(end, Math.max(0, v.currentTime + seconds));
}
</script>

<style scoped>
.playback {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 12px;
  margin: 8px 0;
}
.playback ion-button {
  min-width: var(--app-tap-target, 48px);
  min-height: var(--app-tap-target, 48px);
}
.opt {
  max-width: 180px;
  min-height: var(--app-tap-target, 48px);
}
</style>
