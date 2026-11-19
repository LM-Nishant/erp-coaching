<template>
  <AppPage title="Live classes" :on-refresh="reload">
    <template #actions>
      <ion-button
        v-if="auth.can('live-classes.create')"
        aria-label="Schedule live class"
        @click="openSchedule"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>

    <ion-segment v-model="tab">
      <ion-segment-button value="upcoming"><ion-label>Upcoming</ion-label></ion-segment-button>
      <ion-segment-button value="past"><ion-label>Past</ion-label></ion-segment-button>
      <ion-segment-button value="recordings"><ion-label>Recordings</ion-label></ion-segment-button>
    </ion-segment>

    <ion-list v-if="tab !== 'recordings'">
      <ion-item v-for="s in sessions" :key="s.id" :router-link="`/live-classes/${s.id}`" detail>
        <ion-label>
          <h2>{{ s.title }}</h2>
          <p>{{ s.batchName }} · {{ s.teacher.name }}</p>
          <p>{{ when(s.scheduledStartAt) }} – {{ time(s.scheduledEndAt) }}</p>
        </ion-label>
        <ion-badge slot="end" :color="statusColor(s.status)">{{ s.status }}</ion-badge>
        <ion-button
          v-if="s.status === 'live'"
          slot="end"
          color="danger"
          size="small"
          :router-link="`/live-classes/${s.id}/room`"
          @click.stop
          >Join</ion-button
        >
      </ion-item>
      <ion-item v-if="!loading && !sessions.length">
        <ion-label class="muted">No live classes here.</ion-label>
      </ion-item>
    </ion-list>

    <ion-list v-else>
      <ion-item
        v-for="r in recordings"
        :key="r.id"
        button
        :router-link="`/live-classes/${r.liveSessionId}?recording=${r.id}`"
      >
        <ion-icon slot="start" :icon="playCircleOutline" />
        <ion-label>
          <h2>{{ r.title }}</h2>
          <p>{{ when(r.createdAt) }} · {{ duration(r.durationSeconds) }} · {{ size(r.sizeBytes) }}</p>
        </ion-label>
      </ion-item>
      <ion-item v-if="!loading && !recordings.length">
        <ion-label class="muted">No recordings yet.</ion-label>
      </ion-item>
    </ion-list>

    <ion-modal :is-open="scheduling" @did-dismiss="scheduling = false">
      <ion-header>
        <ion-toolbar>
          <ion-title>Schedule live class</ion-title>
          <ion-buttons slot="end"><ion-button @click="scheduling = false">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <ion-list>
          <ion-item>
            <ion-select v-model="form.batchId" label="Batch" label-placement="stacked" interface="popover">
              <ion-select-option v-for="b in batches" :key="b.id" :value="b.id">{{
                b.name
              }}</ion-select-option>
            </ion-select>
          </ion-item>
          <ion-item v-if="form.batchId">
            <ion-select
              v-model="form.classSessionId"
              label="Timetable class (optional)"
              label-placement="stacked"
              interface="popover"
            >
              <ion-select-option :value="null">Not linked</ion-select-option>
              <ion-select-option v-for="c in classSessions" :key="c.id" :value="c.id">
                {{ c.date }} {{ c.startTime }}–{{ c.endTime }} {{ c.subject?.name ?? '' }}
              </ion-select-option>
            </ion-select>
          </ion-item>
          <ion-item>
            <ion-input v-model="form.title" label="Title" label-placement="stacked" :maxlength="200" />
          </ion-item>
          <template v-if="!form.classSessionId">
            <ion-item>
              <ion-input
                v-model="form.start"
                type="datetime-local"
                label="Starts at"
                label-placement="stacked"
              />
            </ion-item>
            <ion-item>
              <ion-input
                v-model.number="form.duration"
                type="number"
                label="Duration (minutes)"
                label-placement="stacked"
                min="5"
                max="600"
              />
            </ion-item>
          </template>
          <ion-item>
            <ion-textarea
              v-model="form.description"
              label="Description"
              label-placement="stacked"
              auto-grow
            />
          </ion-item>
          <ion-item>
            <ion-toggle v-model="form.recordingEnabled">Record automatically</ion-toggle>
          </ion-item>
        </ion-list>
        <ion-button expand="block" :disabled="saving || !form.batchId" @click="schedule">Schedule</ion-button>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonTextarea,
  IonTitle,
  IonToggle,
  IonToolbar,
  onIonViewWillEnter,
} from '@ionic/vue';
import { add, playCircleOutline } from 'ionicons/icons';
import { useRouter } from 'vue-router';
import type { BatchDto, ClassSessionDto, LiveRecordingDto, LiveSessionDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { academicsApi } from '@/modules/academics/api';
import { liveApi } from './api';
import { duration, size, statusColor, time, when } from './format';

const auth = useAuthStore();
const router = useRouter();
const tab = ref<'upcoming' | 'past' | 'recordings'>('upcoming');
const sessions = ref<LiveSessionDto[]>([]);
const recordings = ref<LiveRecordingDto[]>([]);
const loading = ref(true);

async function load() {
  loading.value = true;
  try {
    if (tab.value === 'recordings') recordings.value = await liveApi.recordings();
    else
      sessions.value = (
        tab.value === 'upcoming'
          ? await liveApi.list({ upcoming: true })
          : await liveApi.list({ status: ['ended', 'cancelled'] })
      ).items;
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}
const reload = () => load();
onIonViewWillEnter(reload);
watch(tab, reload);

/* scheduling */
const scheduling = ref(false);
const saving = ref(false);
const batches = ref<BatchDto[]>([]);
const classSessions = ref<ClassSessionDto[]>([]);
const localInput = (d: Date) => new Date(+d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const form = reactive({
  batchId: null as number | null,
  classSessionId: null as number | null,
  title: '',
  description: '',
  start: localInput(new Date(Date.now() + 3600_000)),
  duration: 60,
  recordingEnabled: true,
});

async function openSchedule() {
  scheduling.value = true;
  try {
    batches.value = (await academicsApi.batches({ status: 'active' })).items;
  } catch (e) {
    await toastError(e);
  }
}

watch(
  () => form.batchId,
  async (batchId) => {
    form.classSessionId = null;
    classSessions.value = [];
    if (!batchId) return;
    const today = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    try {
      classSessions.value = (
        await academicsApi.classSessions({ batchId, from: today, to, status: 'scheduled' })
      ).items;
    } catch {
      classSessions.value = [];
    }
  },
);

async function schedule() {
  saving.value = true;
  try {
    const cs = classSessions.value.find((c) => c.id === form.classSessionId);
    // The device's time zone turns the timetable date/time into an exact instant.
    const start = cs ? new Date(`${cs.date}T${cs.startTime}`) : new Date(form.start);
    const created = await liveApi.create({
      classSessionId: cs?.id,
      batchId: cs ? undefined : form.batchId!,
      title: form.title.trim() || undefined,
      description: form.description.trim() || null,
      scheduledStartAt: start.toISOString(),
      durationMinutes: cs ? undefined : form.duration,
      recordingEnabled: form.recordingEnabled,
    });
    scheduling.value = false;
    await toast('Live class scheduled');
    await router.push(`/live-classes/${created.id}`);
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}
</script>
