<template>
  <AppPage title="Exams" :on-refresh="reload">
    <template #actions>
      <ion-button v-can="'exams.create'" router-link="/exams/new"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>

    <ion-searchbar v-model="search" :debounce="400" placeholder="Search exams" />
    <ion-segment v-model="phase" scrollable>
      <ion-segment-button value=""><ion-label>All</ion-label></ion-segment-button>
      <ion-segment-button v-for="p in PHASES" :key="p" :value="p">
        <ion-label>{{ p }}</ion-label>
      </ion-segment-button>
    </ion-segment>

    <ion-list>
      <ion-item v-for="e in exams" :key="e.id" :router-link="`/exams/${e.id}`" detail>
        <ion-label>
          <h2>{{ e.title }}</h2>
          <p>{{ e.batchName ?? e.courseName ?? 'All students' }} · {{ formatDate(e.startAt) }}</p>
          <p>
            {{ e.questionCount }} questions · {{ fmtMarks(e.totalMarks) }} marks · {{ e.durationMinutes }} min
            ·
            {{ EVALUATION_MODE_LABELS[e.evaluationMode] }}
          </p>
        </ion-label>
        <ion-badge slot="end" :color="PHASE_COLORS[e.phase]">{{ e.phase }}</ion-badge>
      </ion-item>
      <ion-item v-if="!loading && !exams.length">
        <ion-label class="muted">No exams found.</ion-label>
      </ion-item>
    </ion-list>
    <ion-infinite-scroll :disabled="exams.length >= total" @ion-infinite="more">
      <ion-infinite-scroll-content />
    </ion-infinite-scroll>
  </AppPage>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  IonBadge,
  IonButton,
  IonIcon,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonItem,
  IonLabel,
  IonList,
  IonSearchbar,
  IonSegment,
  IonSegmentButton,
  onIonViewWillEnter,
  type InfiniteScrollCustomEvent,
} from '@ionic/vue';
import { add } from 'ionicons/icons';
import { EVALUATION_MODE_LABELS, type ExamDto, type ExamPhase } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toastError } from '@/core/toast';
import { PHASE_COLORS, examsApi, fmtMarks, formatDate } from './api';

const PHASES: ExamPhase[] = ['draft', 'upcoming', 'live', 'closed', 'published', 'cancelled'];
const phase = ref<ExamPhase | ''>('');
const search = ref('');
const exams = ref<ExamDto[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(true);

async function load(reset = true) {
  loading.value = true;
  if (reset) page.value = 1;
  try {
    const res = await examsApi.list({ page: page.value, pageSize: 25, phase: phase.value, q: search.value });
    exams.value = reset ? res.items : [...exams.value, ...res.items];
    total.value = res.total;
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}

const reload = () => load(true);

async function more(ev: InfiniteScrollCustomEvent) {
  page.value++;
  await load(false);
  await ev.target.complete();
}

onIonViewWillEnter(reload);
watch([phase, search], reload);
</script>
