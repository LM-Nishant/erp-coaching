<template>
  <AppPage :title="title" :back-href="backHref">
    <div v-if="error" class="ion-padding">
      <p>{{ error }}</p>
    </div>

    <template v-else-if="playback || offlineUrl">
      <SecureView v-if="isVideo" class="player" screen="lms-content" :text="watermark">
        <video
          ref="videoEl"
          controls
          playsinline
          disablepictureinpicture
          controlslist="nodownload noremoteplayback noplaybackrate"
          preload="metadata"
          @loadedmetadata="onLoaded"
          @timeupdate="onTime"
          @play="playing = true"
          @pause="onPause"
          @ended="onEnded"
          @error="onVideoError"
        />
      </SecureView>

      <template v-else-if="playback?.kind === 'file'">
        <SecureView v-if="inline" class="doc" screen="lms-content" :text="watermark">
          <img v-if="playback.mimeType?.startsWith('image/')" :src="playback.url" alt="" />
          <iframe v-else :src="`${playback.url}#toolbar=0`" title="document" />
        </SecureView>
        <p v-else class="muted">This file type cannot be previewed in the app.</p>
      </template>

      <template v-else-if="playback?.kind === 'link'">
        <ion-button :href="playback.url" target="_blank" rel="noopener">Open link</ion-button>
      </template>

      <p v-if="resource?.description" class="description">{{ resource.description }}</p>

      <div class="actions">
        <ion-button v-if="canDownload" fill="outline" @click="download">
          <ion-icon slot="start" :icon="downloadOutline" />Download
        </ion-button>
        <ion-button v-if="!isVideo && isLearner && !completed" @click="markComplete"
          >Mark as completed</ion-button
        >
        <ion-badge v-if="completed" color="success">Completed</ion-badge>
        <template v-if="showOfflineSave">
          <ion-button v-if="!savedOffline" fill="outline" :disabled="savingOffline" @click="saveForOffline">
            <ion-icon slot="start" :icon="cloudDownloadOutline" />
            {{ savingOffline ? `Saving ${offlinePct}%` : 'Save offline (in app)' }}
          </ion-button>
          <ion-badge v-else color="medium">Saved offline</ion-badge>
        </template>
      </div>
      <p v-if="offlineItem" class="muted">Offline copy · expires {{ fmtDateTime(offlineItem.expiresAt) }}</p>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { useRoute } from 'vue-router';
import { IonBadge, IonButton, IonIcon, onIonViewDidLeave, onIonViewWillEnter } from '@ionic/vue';
import { cloudDownloadOutline, downloadOutline } from 'ionicons/icons';
import type { LmsLearnerResourceDto, LmsPlaybackDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import SecureView from '@/components/SecureView.vue';
import { hlsPlayable, useVideoSource, type VideoSource } from '@/core/hls';
import { useSessionHold } from '@/core/idle';
import { toast, toastError } from '@/core/toast';
import { fmtDateTime, lmsApi } from './api';
import {
  isSavedOffline,
  offlineSupported,
  openOffline,
  saveOffline,
  type OfflineItem,
} from './offline-store';
import { useLmsRole } from './roles';

const REPORT_EVERY_SECONDS = 15;

const route = useRoute();
const { isStaff, isLearner } = useLmsRole();
const id = computed(() => Number(route.params.id));
const offlineMode = computed(() => route.query.offline === '1');

const resource = ref<Partial<LmsLearnerResourceDto> | null>(null);
const playback = ref<LmsPlaybackDto | null>(null);
const offlineUrl = ref<string | null>(null);
const offlineItem = ref<OfflineItem | null>(null);
const error = ref('');
const videoEl = ref<HTMLVideoElement | null>(null);
const completed = ref(false);
const savedOffline = ref(false);
const savingOffline = ref(false);
const offlinePct = ref(0);
// A lecture playing is activity: no inactivity lock mid-video.
const playing = ref(false);
useSessionHold(playing);

let lastTime = 0;
let watchedDelta = 0;
let sinceReport = 0;
let resumeAt = 0;
let refreshing = false;

const title = computed(() => resource.value?.title ?? offlineItem.value?.title ?? 'Lecture');
const backHref = computed(() =>
  offlineMode.value
    ? '/lms/offline'
    : resource.value?.courseId
      ? `/lms/courses/${resource.value.courseId}`
      : '/lms',
);
const isVideo = computed(
  () => !!offlineUrl.value || playback.value?.kind === 'hls' || playback.value?.kind === 'mp4',
);
const videoSource = computed<VideoSource | null>(() => {
  if (offlineUrl.value) return { url: offlineUrl.value, hls: false };
  const p = playback.value;
  return p?.kind === 'hls' || p?.kind === 'mp4' ? { url: p.url, hls: p.kind === 'hls' } : null;
});
const watermark = computed(() => offlineItem.value?.watermark ?? playback.value?.watermark.text ?? '');
const inline = computed(() => {
  const m = playback.value?.mimeType ?? '';
  return m === 'application/pdf' || m.startsWith('image/') || m.startsWith('text/');
});
const canDownload = computed(() => playback.value?.kind === 'file' && playback.value.downloadable);
const showOfflineSave = computed(
  () =>
    !offlineMode.value &&
    isLearner.value &&
    offlineSupported() &&
    isVideo.value &&
    !!playback.value?.offlineAllowed,
);

useVideoSource(videoEl, videoSource, () => void onVideoError());

async function load() {
  error.value = '';
  playback.value = null;
  completed.value = false;
  try {
    if (offlineMode.value) {
      const { url, item } = await openOffline(id.value);
      offlineUrl.value = url;
      offlineItem.value = item;
      return;
    }
    resource.value = isStaff.value ? await lmsApi.resource(id.value) : await lmsApi.learnerResource(id.value);
    completed.value = !!resource.value.progress?.completed;
    playback.value = await lmsApi.play(id.value, hlsPlayable() ? 'hls' : 'mp4');
    resumeAt = playback.value.resumeAtSeconds;
    if (showOfflineSave.value) savedOffline.value = await isSavedOffline(id.value);
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function onLoaded() {
  const v = videoEl.value;
  if (!v) return;
  if (resumeAt > 5 && resumeAt < v.duration - 5) v.currentTime = resumeAt;
  lastTime = v.currentTime;
}

function onTime() {
  const v = videoEl.value;
  if (!v) return;
  const step = v.currentTime - lastTime;
  // only count natural playback, not seeks
  if (step > 0 && step < 2) {
    watchedDelta += step;
    sinceReport += step;
  }
  lastTime = v.currentTime;
  if (sinceReport >= REPORT_EVERY_SECONDS) void flush();
}

function onPause() {
  playing.value = false;
  void flush();
}

function onEnded() {
  playing.value = false;
  void flush(true);
}

async function flush(ended = false) {
  const v = videoEl.value;
  if (!v || !isLearner.value || offlineMode.value) return;
  const delta = Math.round(watchedDelta);
  watchedDelta -= delta;
  sinceReport = 0;
  try {
    const p = await lmsApi.progress(id.value, {
      positionSeconds: Math.floor(ended ? v.duration : v.currentTime),
      durationSeconds: Number.isFinite(v.duration) ? Math.round(v.duration) : null,
      watchedDeltaSeconds: Math.min(delta, 3600),
    });
    completed.value = p.completed;
  } catch {
    watchedDelta += delta;
  }
}

/** Signed URLs are short-lived: on expiry fetch a fresh one and continue where the learner was. */
async function onVideoError() {
  if (offlineMode.value || refreshing || !playback.value) return;
  refreshing = true;
  try {
    const at = videoEl.value?.currentTime ?? 0;
    playback.value = await lmsApi.play(id.value, hlsPlayable() ? 'hls' : 'mp4');
    resumeAt = at;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    setTimeout(() => (refreshing = false), 5000);
  }
}

async function markComplete() {
  try {
    completed.value = (await lmsApi.progress(id.value, { positionSeconds: 0, completed: true })).completed;
  } catch (e) {
    await toastError(e);
  }
}

async function download() {
  try {
    const { url } = await lmsApi.download(id.value);
    window.open(url, '_blank', 'noopener');
  } catch (e) {
    await toastError(e);
  }
}

async function saveForOffline() {
  savingOffline.value = true;
  offlinePct.value = 0;
  try {
    await saveOffline(id.value, (d, t) => (offlinePct.value = t ? Math.round((d / t) * 100) : 0));
    savedOffline.value = true;
    await toast('Saved for offline viewing in this app');
  } catch (e) {
    await toastError(e);
  } finally {
    savingOffline.value = false;
  }
}

async function leave() {
  await flush();
  videoEl.value?.pause();
  if (offlineUrl.value) URL.revokeObjectURL(offlineUrl.value);
  offlineUrl.value = null;
}

onIonViewWillEnter(load);
onIonViewDidLeave(leave);
onBeforeUnmount(() => void leave());
</script>

<style scoped>
.player,
.doc {
  position: relative;
  background: #000;
  overflow: hidden;
  border-radius: 8px;
}
.player video {
  display: block;
  width: 100%;
  max-height: 70vh;
}
.doc {
  background: #fff;
}
.doc iframe {
  width: 100%;
  height: 75vh;
  border: 0;
}
.doc img {
  max-width: 100%;
}
.description {
  white-space: pre-wrap;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-top: 12px;
}
</style>
