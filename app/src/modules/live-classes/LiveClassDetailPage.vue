<template>
  <AppPage :title="session?.title ?? 'Live class'" back-href="/live-classes" :on-refresh="load">
    <template v-if="session">
      <ion-card>
        <ion-card-header>
          <ion-card-subtitle>
            <ion-badge :color="statusColor(session.status)">{{ session.status }}</ion-badge>
            {{ session.batchName }}
          </ion-card-subtitle>
          <ion-card-title>{{ session.title }}</ion-card-title>
        </ion-card-header>
        <ion-card-content>
          <p>Teacher: {{ session.teacher.name }}</p>
          <p>Scheduled: {{ when(session.scheduledStartAt) }} – {{ time(session.scheduledEndAt) }}</p>
          <p v-if="session.startedAt">Started: {{ when(session.startedAt) }}</p>
          <p v-if="session.endedAt">Ended: {{ when(session.endedAt) }}</p>
          <p v-if="session.description">{{ session.description }}</p>
          <p class="muted">Recording {{ session.recordingEnabled ? 'on' : 'off' }}</p>
        </ion-card-content>
      </ion-card>

      <div class="actions">
        <ion-button v-if="isHost && session.status === 'scheduled'" color="danger" @click="start">
          <ion-icon slot="start" :icon="radioOutline" />Go live
        </ion-button>
        <ion-button v-if="session.status === 'live'" color="danger" :router-link="`/live-classes/${id}/room`">
          <ion-icon slot="start" :icon="enterOutline" />{{ isHost ? 'Open console' : 'Join class' }}
        </ion-button>
        <ion-button v-if="isModerator && session.status === 'live'" fill="outline" @click="end"
          >End class</ion-button
        >
        <ion-button v-if="isModerator && session.status === 'scheduled'" fill="outline" @click="cancel">
          Cancel class
        </ion-button>
        <ion-button
          v-if="
            isModerator &&
            auth.can('live-classes.delete') &&
            ['scheduled', 'cancelled'].includes(session.status)
          "
          fill="clear"
          color="danger"
          @click="remove"
          >Delete</ion-button
        >
      </div>

      <template v-if="recordings.length">
        <ion-list-header><ion-label>Recordings</ion-label></ion-list-header>
        <ion-list>
          <ion-item v-for="r in recordings" :key="r.id" button @click="play(r.id)">
            <ion-icon slot="start" :icon="playCircleOutline" />
            <ion-label>
              <h3>{{ r.title }}</h3>
              <p>{{ duration(r.durationSeconds) }} · {{ size(r.sizeBytes) }}</p>
            </ion-label>
          </ion-item>
        </ion-list>
        <SecureView v-if="playing" screen="live-recording">
          <video
            :src="playing"
            controls
            playsinline
            disablepictureinpicture
            controlslist="nodownload noremoteplayback"
            class="player"
            @play="videoPlaying = true"
            @pause="videoPlaying = false"
            @ended="videoPlaying = false"
          />
        </SecureView>
      </template>

      <template v-if="report">
        <ion-list-header>
          <ion-label
            >Attendance ({{ report.joinedStudents }}/{{ report.enrolledStudents }} students joined)</ion-label
          >
        </ion-list-header>
        <ion-list>
          <ion-item v-for="p in report.participants" :key="p.userId">
            <ion-label>
              <h3>
                {{ p.name }} <span class="muted">· {{ p.role }}</span>
              </h3>
              <p>
                {{ duration(p.totalSeconds) }} attended · joined {{ p.joinCount }}×
                <span v-if="p.firstJoinedAt">· first {{ time(p.firstJoinedAt) }}</span>
              </p>
            </ion-label>
            <ion-badge v-if="p.online" slot="end" color="success">online</ion-badge>
          </ion-item>
          <ion-item v-for="a in report.absent" :key="`a${a.id}`">
            <ion-label
              ><h3>{{ a.name }}</h3>
              <p>Did not join</p></ion-label
            >
            <ion-badge slot="end" color="medium">absent</ion-badge>
          </ion-item>
        </ion-list>
      </template>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  IonBadge,
  IonButton,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardSubtitle,
  IonCardTitle,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  alertController,
  onIonViewDidLeave,
  onIonViewWillEnter,
} from '@ionic/vue';
import { enterOutline, playCircleOutline, radioOutline } from 'ionicons/icons';
import type { LiveRecordingDto, LiveSessionDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import SecureView from '@/components/SecureView.vue';
import { useSessionHold } from '@/core/idle';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { liveApi, type ParticipationReport } from './api';
import { duration, size, statusColor, time, when } from './format';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const id = Number(route.params.id);
const session = ref<LiveSessionDto | null>(null);
const recordings = ref<LiveRecordingDto[]>([]);
const report = ref<ParticipationReport | null>(null);
const playing = ref<string | null>(null);
const videoPlaying = ref(false);
useSessionHold(videoPlaying);

const isHost = computed(() => session.value?.myRole === 'host');
const isModerator = computed(() => session.value?.myRole === 'host' || session.value?.myRole === 'moderator');

async function load() {
  try {
    session.value = await liveApi.get(id);
    recordings.value = await liveApi.recordings({ liveSessionId: id });
    report.value =
      isModerator.value && session.value.status !== 'scheduled' ? await liveApi.participants(id) : null;
  } catch (e) {
    await toastError(e);
  }
}
onIonViewWillEnter(load);
// Hidden Ionic pages stay mounted: stop the recording rather than let it play on in the background.
onIonViewDidLeave(() => {
  playing.value = null;
  videoPlaying.value = false;
});

async function run(fn: () => Promise<unknown>, done?: string) {
  try {
    await fn();
    if (done) await toast(done);
    await load();
  } catch (e) {
    await toastError(e);
  }
}

async function confirm(message: string) {
  const a = await alertController.create({
    header: 'Are you sure?',
    message,
    buttons: [
      { text: 'No', role: 'cancel' },
      { text: 'Yes', role: 'confirm' },
    ],
  });
  await a.present();
  return (await a.onDidDismiss()).role === 'confirm';
}

const start = () =>
  run(async () => {
    await liveApi.start(id);
    await router.push(`/live-classes/${id}/room`);
  });
const end = async () =>
  (await confirm('End the class for everyone?')) && run(() => liveApi.end(id), 'Class ended');
const cancel = async () =>
  (await confirm('Cancel this live class?')) && run(() => liveApi.cancel(id), 'Class cancelled');
const remove = async () => {
  if (!(await confirm('Delete this live class?'))) return;
  try {
    await liveApi.remove(id);
    await router.replace('/live-classes');
  } catch (e) {
    await toastError(e);
  }
};

async function play(recordingId: number) {
  try {
    videoPlaying.value = false;
    playing.value = (await liveApi.recordingUrl(recordingId)).url;
  } catch (e) {
    await toastError(e);
  }
}
</script>

<style scoped>
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 8px 0 16px;
}
.player {
  width: 100%;
  max-height: 60vh;
  background: #000;
  border-radius: 8px;
}
</style>
