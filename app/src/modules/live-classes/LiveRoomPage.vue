<template>
  <AppPage :title="title" :back-href="`/live-classes/${id}`">
    <div v-if="loading" class="center"><ion-spinner /></div>

    <div v-else-if="fatal" class="center">
      <p>{{ fatal }}</p>
      <ion-button :router-link="`/live-classes/${id}`">Back to class</ion-button>
    </div>

    <div v-else-if="live && live.room.ended" class="center">
      <h2>This live class has ended</h2>
      <p v-if="recorder && (recorder.uploading.value || saving)">
        Saving the recording… please keep this page open.
      </p>
      <ion-button :router-link="`/live-classes/${id}`">Back to class</ion-button>
    </div>

    <div v-else-if="live" class="room">
      <section class="stage-col">
        <div class="status-bar">
          <ion-badge :color="live.room.connected ? 'danger' : 'medium'">
            {{ live.room.connected ? '● LIVE' : 'Reconnecting…' }}
          </ion-badge>
          <ion-badge v-if="recorder?.recording.value" color="dark">⏺ Recording</ion-badge>
          <ion-badge v-if="recorder?.uploading.value" color="warning">Uploading recording…</ion-badge>
          <ion-badge v-if="live.room.screenSharing" color="tertiary">Screen sharing</ion-badge>
          <span class="spacer" />
          <span class="muted small"
            >{{ onlineStudents }} student{{ onlineStudents === 1 ? '' : 's' }} online</span
          >
        </div>

        <div class="stage">
          <Whiteboard
            v-if="live.room.whiteboard.visible"
            ref="board"
            :strokes="live.room.whiteboard.strokes"
            :editable="isHost"
            @stroke="(s) => act(() => live!.stroke(s))"
            @undo="act(() => live!.undo())"
            @clear="act(() => live!.clearBoard())"
          />
          <div v-show="!live.room.whiteboard.visible" class="video-wrap">
            <video ref="stageVideo" v-src="stageStream" autoplay playsinline muted />
            <div v-if="!isHost && !viewer?.video.value" class="placeholder">
              {{ live.room.hostOnline ? 'Connecting to the teacher…' : 'Waiting for the teacher to join…' }}
            </div>
          </div>
          <video
            v-show="live.room.whiteboard.visible"
            ref="pipVideo"
            v-src="pipStream"
            class="pip"
            autoplay
            playsinline
            muted
          />
        </div>
        <audio v-if="audioStream" ref="audioEl" v-src="audioStream" autoplay />
        <ion-button v-if="needsUnmute" expand="block" color="warning" @click="unmute"
          >Tap to enable sound</ion-button
        >

        <!-- Teacher console -->
        <div v-if="isHost && teacher" class="controls">
          <ion-button :fill="teacher.micOn.value ? 'solid' : 'outline'" @click="teacher.toggleMic()">
            <ion-icon slot="start" :icon="teacher.micOn.value ? mic : micOff" />
            {{ teacher.micOn.value ? 'Mic on' : 'Mic off' }}
          </ion-button>
          <ion-button :fill="teacher.camOn.value ? 'solid' : 'outline'" @click="teacher.toggleCam()">
            <ion-icon slot="start" :icon="teacher.camOn.value ? videocam : videocamOff" />
            {{ teacher.camOn.value ? 'Camera on' : 'Camera off' }}
          </ion-button>
          <ion-button
            v-if="teacher.canShareScreen"
            :fill="teacher.screen.value ? 'solid' : 'outline'"
            @click="toggleScreen"
          >
            <ion-icon slot="start" :icon="desktopOutline" />
            {{ teacher.screen.value ? 'Stop sharing' : 'Share screen' }}
          </ion-button>
          <ion-button
            :fill="live.room.whiteboard.visible ? 'solid' : 'outline'"
            @click="act(() => live!.setBoardVisible(!live!.room.whiteboard.visible))"
          >
            <ion-icon slot="start" :icon="brushOutline" />
            {{ live.room.whiteboard.visible ? 'Hide whiteboard' : 'Whiteboard' }}
          </ion-button>
          <ion-button color="danger" :disabled="saving" @click="endClass">
            <ion-icon slot="start" :icon="stopCircleOutline" />
            End class
          </ion-button>
        </div>
        <p v-if="isHost && recordingUnsupported" class="muted small">
          This device can't record the class automatically. Use a desktop browser to record.
        </p>
        <p v-if="isHost && mediaError" class="warn small">{{ mediaError }}</p>

        <!-- Student controls -->
        <div v-if="!isHost" class="controls">
          <ion-button v-if="iSpeak" color="success" fill="solid" disabled>
            <ion-icon slot="start" :icon="mic" /> Your mic is on
          </ion-button>
          <ion-button v-else-if="handRaised" fill="outline" @click="act(() => live!.lowerHand())">
            <ion-icon slot="start" :icon="handLeftOutline" /> Lower hand
          </ion-button>
          <ion-button v-else-if="live.room.me?.role === 'student'" @click="act(() => live!.raiseHand())">
            <ion-icon slot="start" :icon="handLeftOutline" /> Raise hand
          </ion-button>
          <ion-button fill="clear" color="medium" @click="leave">Leave</ion-button>
        </div>
        <p v-if="!isHost && iSpeak" class="muted small">
          The teacher allowed your microphone — everyone can hear you.
        </p>
      </section>

      <section class="panel-col">
        <RoomPanel :live="live" />
      </section>
    </div>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, type Directive } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { IonBadge, IonButton, IonIcon, IonSpinner, onIonViewWillLeave } from '@ionic/vue';
import {
  brushOutline,
  desktopOutline,
  handLeftOutline,
  mic,
  micOff,
  stopCircleOutline,
  videocam,
  videocamOff,
} from 'ionicons/icons';
import AppPage from '@/components/AppPage.vue';
import { errorMessage } from '@/core/api';
import { toast, toastError } from '@/core/toast';
import { liveApi } from './api';
import RoomPanel from './components/RoomPanel.vue';
import Whiteboard from './components/Whiteboard.vue';
import { useLiveSocket, type LiveSocket } from './composables/useLiveSocket';
import { useTeacherMedia, useViewerMedia } from './composables/useLiveMedia';
import { recordingSupported, useClassRecorder } from './composables/useClassRecorder';

const vSrc: Directive<HTMLMediaElement, MediaStream | null | undefined> = {
  mounted: (el, { value }) => void (el.srcObject = value ?? null),
  updated: (el, { value }) => {
    if (el.srcObject !== (value ?? null)) el.srcObject = value ?? null;
  },
};

const route = useRoute();
const router = useRouter();
const id = Number(route.params.id);

const loading = ref(true);
const fatal = ref<string | null>(null);
const mediaError = ref<string | null>(null);
const saving = ref(false);
const needsUnmute = ref(false);
const live = shallowRef<LiveSocket | null>(null);
const teacher = shallowRef<ReturnType<typeof useTeacherMedia> | null>(null);
const viewer = shallowRef<ReturnType<typeof useViewerMedia> | null>(null);
const recorder = shallowRef<ReturnType<typeof useClassRecorder> | null>(null);
const recordingUnsupported = ref(false);
const stageVideo = ref<HTMLVideoElement | null>(null);
const pipVideo = ref<HTMLVideoElement | null>(null);
const audioEl = ref<HTMLAudioElement | null>(null);
const board = ref<InstanceType<typeof Whiteboard> | null>(null);
let closed = false;

const title = computed(() => live.value?.room.session?.title ?? 'Live class');
const isHost = computed(() => live.value?.room.me?.role === 'host');
const meId = computed(() => live.value?.room.me?.id);
const handRaised = computed(() => !!live.value?.room.hands.some((h) => h.id === meId.value));
const iSpeak = computed(() => !!live.value?.room.speakers.some((s) => s.id === meId.value));
const onlineStudents = computed(
  () => live.value?.room.participants.filter((p) => p.online && p.role === 'student').length ?? 0,
);
const stageStream = computed(
  () => (isHost.value ? teacher.value?.preview.value : viewer.value?.video.value) ?? null,
);
const pipStream = computed(
  () => (isHost.value ? teacher.value?.camera.value : viewer.value?.video.value) ?? null,
);
const audioStream = computed(
  () => (isHost.value ? teacher.value?.speakerAudio.value : viewer.value?.audio.value) ?? null,
);

async function act(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    toastError(e);
  }
}

watch(audioStream, async (s) => {
  if (!s) return;
  await nextTick();
  audioEl.value?.play().then(
    () => (needsUnmute.value = false),
    (e: DOMException) => (needsUnmute.value = e.name === 'NotAllowedError'),
  );
});

function unmute() {
  void audioEl.value?.play().then(() => (needsUnmute.value = false));
}

async function toggleScreen() {
  const t = teacher.value!;
  await act(() => (t.screen.value ? t.stopScreen() : t.startScreen()));
}

function setupRecorder(l: LiveSocket) {
  if (!recordingSupported()) {
    recordingUnsupported.value = true;
    return;
  }
  const rec = useClassRecorder(
    {
      video: () => stageVideo.value,
      camera: () => pipVideo.value,
      board: () => (l.room.whiteboard.visible ? (board.value?.canvas() ?? null) : null),
      audio: () =>
        [teacher.value?.camera.value, teacher.value?.speakerAudio.value].filter((s): s is MediaStream => !!s),
    },
    (blob, seconds) => liveApi.uploadRecording(id, blob, seconds),
  );
  recorder.value = rec;
  const stopWatch = watch(
    () => l.room.joined,
    (joined) => {
      if (joined && l.room.session?.recordingEnabled) {
        rec.start();
        stopWatch();
      }
    },
    { immediate: true },
  );
}

async function init() {
  try {
    const info = await liveApi.join(id);
    if (info.transport !== 'socket-webrtc') {
      fatal.value = `The "${info.provider}" streaming provider needs its SDK client, which this build does not include.`;
      return;
    }
    if (info.role === 'host') {
      const l = useLiveSocket(id, info);
      const t = useTeacherMedia(l, info);
      live.value = l;
      teacher.value = t;
      // Not awaited: the permission prompt can take a while; peers get the tracks once they exist.
      t.startCamera().catch((e) => {
        mediaError.value = `Camera/microphone unavailable: ${errorMessage(e)}. Students will only see the whiteboard.`;
      });
      watch(
        () => l.room.speakers.map((s) => s.id).join(','),
        () => void t.setSpeakers(l.room.speakers),
      );
      setupRecorder(l);
    } else {
      const l = useLiveSocket(id, info);
      const v = useViewerMedia(l, info);
      live.value = l;
      viewer.value = v;
      watch(
        () => l.room.speakers.some((s) => s.id === l.room.me?.id),
        (granted) =>
          void v.setMicGranted(granted).catch((e) => {
            toastError(e);
            void l.revokeMic(l.room.me!.id).catch(() => {});
          }),
      );
    }
  } catch (e) {
    fatal.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}

async function cleanup() {
  if (closed) return;
  closed = true;
  const rec = recorder.value;
  teacher.value?.stopScreen().catch(() => {});
  if (rec) await rec.stop().catch(() => {});
  teacher.value?.stop();
  viewer.value?.stop();
  live.value?.close();
}

async function endClass() {
  saving.value = true;
  try {
    await recorder.value?.stop();
    await liveApi.end(id);
    toast('Class ended');
    await cleanup();
    await router.replace(`/live-classes/${id}`);
  } catch (e) {
    toastError(e);
  } finally {
    saving.value = false;
  }
}

async function leave() {
  await cleanup();
  await router.replace(`/live-classes/${id}`);
}

onMounted(init);
onIonViewWillLeave(() => void cleanup());
onBeforeUnmount(() => void cleanup());
</script>

<style scoped>
.center {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 48px 16px;
}
.room {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 360px;
  gap: 12px;
  padding: 8px;
  height: 100%;
}
@media (max-width: 900px) {
  .room {
    grid-template-columns: 1fr;
  }
}
.panel-col {
  border: 1px solid var(--ion-color-light-shade);
  border-radius: 8px;
  min-height: 420px;
  max-height: calc(100vh - 140px);
  display: flex;
  flex-direction: column;
}
.status-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  flex-wrap: wrap;
}
.spacer {
  flex: 1;
}
.stage {
  position: relative;
}
.video-wrap {
  position: relative;
  aspect-ratio: 16 / 9;
  background: #111;
  border-radius: 8px;
  overflow: hidden;
}
.video-wrap video {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #ddd;
}
.pip {
  position: absolute;
  right: 8px;
  top: 8px;
  width: 22%;
  aspect-ratio: 16 / 9;
  background: #111;
  border-radius: 6px;
  object-fit: cover;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
}
.controls {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}
.muted {
  color: var(--ion-color-medium);
}
.warn {
  color: var(--ion-color-danger);
}
.small {
  font-size: 12px;
}
</style>
