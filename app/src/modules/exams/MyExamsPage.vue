<template>
  <AppPage :title="t('exams.my.title')" :on-refresh="load">
    <div v-if="loading && !items.length" class="ion-text-center ion-padding"><ion-spinner /></div>
    <template v-for="g in groups" :key="g.key">
      <ion-list v-if="g.items.length">
        <ion-list-header>
          <ion-label>{{ g.title }}</ion-label>
        </ion-list-header>
        <ion-item v-for="it in g.items" :key="it.exam.id" lines="full">
          <ion-label class="ion-text-wrap">
            <h2>{{ it.exam.title }}</h2>
            <p>{{ formatDateTime(it.exam.startAt) }} – {{ formatDateTime(it.exam.endAt) }}</p>
            <p>
              {{ t('exams.my.minutes', { n: it.exam.durationMinutes }) }} ·
              {{ t('exams.my.marks', { n: fmtMarks(it.exam.totalMarks) }) }} ·
              {{ t('exams.my.questions', { n: it.exam.questionCount }, it.exam.questionCount) }}
            </p>
            <p v-if="it.exam.courseName || it.exam.batchName" class="muted">
              {{ [it.exam.courseName, it.exam.batchName].filter(Boolean).join(' · ') }}
            </p>
            <ion-badge :color="statusOf(it).color">{{ statusOf(it).label }}</ion-badge>
          </ion-label>
          <div slot="end" class="actions">
            <ion-button
              v-if="it.canStart"
              size="small"
              :color="it.attempt ? 'warning' : 'success'"
              :disabled="busyId === it.exam.id"
              @click="start(it)"
            >
              <ion-icon slot="start" :icon="it.attempt ? playForwardOutline : playOutline" />
              {{ it.attempt ? t('exams.my.resume') : t('exams.my.start') }}
            </ion-button>
            <ion-button
              v-else-if="resultPublished(it)"
              size="small"
              fill="outline"
              :router-link="`/exam-results/${it.attempt!.id}`"
            >
              <ion-icon slot="start" :icon="ribbonOutline" />{{ t('exams.my.viewResult') }}
            </ion-button>
          </div>
        </ion-item>
      </ion-list>
    </template>
    <ion-list v-if="!loading && !items.length">
      <ion-item>
        <ion-label class="muted">{{ t('exams.my.empty') }}</ion-label>
      </ion-item>
    </ion-list>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  IonBadge,
  IonButton,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonSpinner,
  alertController,
  onIonViewWillEnter,
} from '@ionic/vue';
import { playForwardOutline, playOutline, ribbonOutline } from 'ionicons/icons';
import type { StudentExamListItem } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { formatDateTime } from '@/core/format';
import { toastError } from '@/core/toast';
import { examsApi, fmtMarks } from './api';

const router = useRouter();
const { t } = useI18n();
const items = ref<StudentExamListItem[]>([]);
const loading = ref(true);
const busyId = ref<number | null>(null);

const isDone = (it: StudentExamListItem) =>
  (!!it.attempt && it.attempt.status !== 'in_progress') ||
  (!it.canStart && (it.exam.phase === 'closed' || it.exam.phase === 'published'));

const resultPublished = (it: StudentExamListItem) =>
  !!it.exam.resultsPublishedAt && !!it.attempt && it.attempt.status !== 'in_progress';

const groups = computed(() => {
  const live: StudentExamListItem[] = [];
  const upcoming: StudentExamListItem[] = [];
  const done: StudentExamListItem[] = [];
  for (const it of items.value) {
    if (it.canStart) live.push(it);
    else if (isDone(it)) done.push(it);
    else if (it.exam.phase === 'upcoming') upcoming.push(it);
    else done.push(it);
  }
  const byStart = (a: StudentExamListItem, b: StudentExamListItem) =>
    a.exam.startAt.localeCompare(b.exam.startAt);
  return [
    { key: 'live', title: t('common.status.live'), items: live.sort(byStart) },
    { key: 'upcoming', title: t('common.status.upcoming'), items: upcoming.sort(byStart) },
    { key: 'done', title: t('common.status.completed'), items: done.sort((a, b) => byStart(b, a)) },
  ];
});

function statusOf(it: StudentExamListItem): { label: string; color: string } {
  const a = it.attempt;
  if (a?.status === 'in_progress') return { label: t('common.status.inProgress'), color: 'warning' };
  if (resultPublished(it)) return { label: t('exams.my.status.resultPublished'), color: 'tertiary' };
  if (a?.status === 'submitted') return { label: t('exams.my.status.submitted'), color: 'primary' };
  if (a?.status === 'auto_submitted') return { label: t('exams.my.status.autoSubmitted'), color: 'primary' };
  if (it.canStart) return { label: t('exams.my.status.live'), color: 'success' };
  if (it.exam.phase === 'upcoming')
    return { label: t('exams.my.status.opens', { date: formatDateTime(it.exam.startAt) }), color: 'medium' };
  return { label: t('exams.my.status.missed'), color: 'danger' };
}

async function load() {
  loading.value = true;
  try {
    items.value = await examsApi.myExams();
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}

async function confirmStart(it: StudentExamListItem): Promise<boolean> {
  const e = it.exam;
  const parts = [
    t('exams.my.confirm.duration', { n: e.durationMinutes, marks: fmtMarks(e.totalMarks) }),
    t('exams.my.confirm.finishBy', { date: formatDateTime(e.endAt) }),
  ];
  if (e.defaultNegativeMarks > 0) parts.push(t('exams.my.confirm.negative'));
  if (e.instructions) parts.push(e.instructions);
  const alert = await alertController.create({
    header: e.title,
    subHeader: t('exams.my.confirm.header'),
    message: parts.join('\n\n'),
    buttons: [
      { text: t('common.actions.cancel'), role: 'cancel' },
      { text: t('exams.my.confirm.start'), role: 'confirm' },
    ],
  });
  await alert.present();
  return (await alert.onDidDismiss()).role === 'confirm';
}

async function start(it: StudentExamListItem) {
  if (!it.attempt && !(await confirmStart(it))) return;
  busyId.value = it.exam.id;
  try {
    const s = await examsApi.start(it.exam.id);
    await router.push(`/my-exams/attempts/${s.attemptId}`);
  } catch (e) {
    await toastError(e);
    await load();
  } finally {
    busyId.value = null;
  }
}

onIonViewWillEnter(load);
</script>

<style scoped>
.actions {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}
ion-badge {
  margin-top: 4px;
}
</style>
