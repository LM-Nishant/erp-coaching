<template>
  <AppPage :title="t('exams.list.title')" :on-refresh="reload">
    <template #actions>
      <ion-button v-can="'exams.create'" router-link="/exams/new" :aria-label="t('exams.form.newTitle')"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>

    <ion-searchbar v-model="search" :debounce="400" :placeholder="t('exams.list.search')" />
    <ion-segment v-model="phase" scrollable>
      <ion-segment-button value=""
        ><ion-label>{{ t('exams.list.all') }}</ion-label></ion-segment-button
      >
      <ion-segment-button v-for="p in PHASES" :key="p" :value="p">
        <ion-label>{{ t(`exams.phase.${p}`) }}</ion-label>
      </ion-segment-button>
    </ion-segment>

    <ion-list>
      <ion-item v-for="e in exams" :key="e.id" :router-link="`/exams/${e.id}`" detail>
        <ion-label>
          <h2>{{ e.title }}</h2>
          <p>
            {{ e.batchName ?? e.courseName ?? t('exams.list.allStudents') }} · {{ formatDateTime(e.startAt) }}
          </p>
          <p>
            {{
              t('exams.list.facts', {
                questions: e.questionCount,
                marks: fmtMarks(e.totalMarks),
                duration: formatDuration(e.durationMinutes * 60),
              })
            }}
          </p>
        </ion-label>
        <StatusChip slot="end" :tone="PHASE_TONE[e.phase]" :label="t(`exams.phase.${e.phase}`)" />
      </ion-item>
    </ion-list>
    <EmptyState
      v-if="!loading && !exams.length"
      :icon="documentTextOutline"
      :title="search || phase ? t('exams.list.noMatch') : t('exams.list.emptyTitle')"
      :message="search || phase ? undefined : t('exams.list.emptyMessage')"
    >
      <ion-button v-if="!search && !phase" v-can="'exams.create'" router-link="/exams/new">{{
        t('exams.form.newTitle')
      }}</ion-button>
    </EmptyState>
    <ion-infinite-scroll :disabled="exams.length >= total" @ion-infinite="more">
      <ion-infinite-scroll-content />
    </ion-infinite-scroll>
  </AppPage>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import {
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
import { add, documentTextOutline } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import type { ExamDto, ExamPhase } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import EmptyState from '@/components/EmptyState.vue';
import StatusChip from '@/components/StatusChip.vue';
import { formatDateTime, formatDuration } from '@/core/format';
import { toastError } from '@/core/toast';
import { examsApi, fmtMarks } from './api';

const { t } = useI18n();
const PHASE_TONE: Record<ExamPhase, 'success' | 'warning' | 'danger' | 'primary' | 'medium'> = {
  draft: 'medium',
  upcoming: 'primary',
  live: 'success',
  closed: 'warning',
  published: 'success',
  cancelled: 'danger',
};
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
