<template>
  <div>
    <video
      ref="videoEl"
      class="stream-player"
      controls
      playsinline
      controlslist="nodownload"
      :poster="poster ?? undefined"
      @timeupdate="emit('time', ($event.target as HTMLVideoElement).currentTime)"
      @loadedmetadata="onLoaded"
      @ended="emit('ended')"
      @pause="emit('pause', ($event.target as HTMLVideoElement).currentTime)"
    />
    <PlaybackControls v-if="controlsBar" v-model:quality="quality" :video="videoEl" :qualities="qualities" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { MktStreamDto } from '@erp/shared';
import PlaybackControls from '@/components/PlaybackControls.vue';
import { hlsPlayable, useVideoSource, type VideoSource } from '@/core/hls';

const props = defineProps<{
  stream: MktStreamDto | null;
  startAt?: number;
  poster?: string | null;
  /** Show speed, ±10 s and quality controls under the video (the course player). */
  controlsBar?: boolean;
}>();
const emit = defineEmits<{ time: [number]; ended: []; pause: [number]; expired: [] }>();
const videoEl = ref<HTMLVideoElement | null>(null);

const source = computed<VideoSource | null>(() => {
  const s = props.stream;
  if (!s) return null;
  if (s.hlsUrl && hlsPlayable()) return { url: s.hlsUrl, hls: true };
  return s.fileUrl ? { url: s.fileUrl, hls: false } : null;
});
const { qualities, quality } = useVideoSource(videoEl, source, () => emit('expired'));

function onLoaded() {
  const el = videoEl.value;
  // Resume where the learner left off, unless that was the very end.
  if (el && props.startAt && props.startAt < el.duration - 5) el.currentTime = props.startAt;
}
</script>

<style scoped>
.stream-player {
  width: 100%;
  aspect-ratio: 16 / 9;
  background: #000;
  border-radius: 8px;
  display: block;
}
</style>
