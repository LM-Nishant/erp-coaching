<template>
  <AppPage title="Results & analytics" :back-href="`/exams/${id}`" :on-refresh="load">
    <template #actions>
      <ion-button v-can="'exams.export'" aria-label="Export CSV" @click="exportCsv"
        ><ion-icon slot="icon-only" :icon="downloadOutline"
      /></ion-button>
    </template>

    <ion-card v-if="exam">
      <ion-card-header>
        <ion-card-subtitle>
          <ion-badge :color="PHASE_COLORS[exam.phase]">{{ exam.phase }}</ion-badge>
          <span v-if="exam.resultsPublishedAt"> · published {{ formatDate(exam.resultsPublishedAt) }}</span>
        </ion-card-subtitle>
        <ion-card-title>{{ exam.title }}</ion-card-title>
      </ion-card-header>
      <ion-card-content v-if="stats">
        <div class="stats">
          <div>
            <strong>{{ stats.submitted }}</strong><span>submitted / {{ stats.eligible }} eligible</span>
          </div>
          <div>
            <strong>{{ fmtMarks(stats.average) }}</strong><span>average</span>
          </div>
          <div>
            <strong>{{ fmtMarks(stats.median) }}</strong><span>median</span>
          </div>
          <div>
            <strong>{{ fmtMarks(stats.highest) }}</strong><span>highest</span>
          </div>
          <div>
            <strong>{{ fmtMarks(stats.lowest) }}</strong><span>lowest</span>
          </div>
          <div v-if="stats.passCount !== null">
            <strong>{{ stats.passCount }}</strong><span>passed</span>
          </div>
        </div>
        <div class="actions">
          <template v-if="can('exams.publish')">
            <ion-button v-if="!exam.resultsPublishedAt" size="small" @click="publish(true)"
              >Publish results</ion-button
            >
            <ion-button v-else size="small" fill="outline" color="warning" @click="publish(false)"
              >Unpublish</ion-button
            >
          </template>
          <ion-button
            v-can="'exams.approve'"
            size="small"
            fill="outline"
            :router-link="`/exams/${id}/evaluate`"
          >
            Evaluate ({{ pending }} pending)
          </ion-button>
        </div>
      </ion-card-content>
    </ion-card>

    <ion-segment v-model="tab">
      <ion-segment-button value="students"><ion-label>Students</ion-label></ion-segment-button>
      <ion-segment-button value="topics"><ion-label>Topics</ion-label></ion-segment-button>
      <ion-segment-button value="questions"><ion-label>Questions</ion-label></ion-segment-button>
    </ion-segment>

    <ion-list v-if="tab === 'students'">
      <ion-item v-for="a in attempts" :key="a.id" :router-link="`/exams/${id}/attempts/${a.id}`" detail>
        <ion-label>
          <h3>
            <span v-if="a.rank">#{{ a.rank }} · </span>{{ a.studentName ?? `Student #${a.studentUserId}` }}
          </h3>
          <p>
            {{ a.status.replace('_', ' ') }} · {{ formatDate(a.submittedAt ?? a.startedAt) }}
            <span v-if="a.pendingEvaluations"> · {{ a.pendingEvaluations }} to evaluate</span>
          </p>
        </ion-label>
        <ion-note slot="end">
          {{ fmtMarks(a.totalScore) }} / {{ fmtMarks(a.maxScore) }}
          <span v-if="a.percentile !== null"><br />{{ fmtMarks(a.percentile) }} pct</span>
        </ion-note>
      </ion-item>
      <ion-item v-if="!attempts.length"><ion-label class="muted">No attempts yet.</ion-label></ion-item>
    </ion-list>

    <template v-if="tab === 'topics' && stats">
      <ion-card>
        <ion-card-header><ion-card-subtitle>Score distribution</ion-card-subtitle></ion-card-header>
        <ion-card-content>
          <div v-for="d in stats.distribution" :key="d.range" class="bar-row">
            <span class="lbl">{{ d.range }}</span>
            <div class="bar"><div :style="{ width: `${(d.count / maxBucket) * 100}%` }" /></div>
            <span class="val">{{ d.count }}</span>
          </div>
        </ion-card-content>
      </ion-card>
      <ion-card>
        <ion-card-header><ion-card-subtitle>Chapter / topic accuracy</ion-card-subtitle></ion-card-header>
        <ion-card-content>
          <div v-for="t in stats.topics" :key="t.key" class="bar-row">
            <span class="lbl">{{
              [t.chapterName, t.topicName].filter(Boolean).join(' › ') || 'Untagged'
            }}</span>
            <div class="bar"><div :class="accClass(t.accuracy)" :style="{ width: `${t.accuracy}%` }" /></div>
            <span class="val">{{ fmtMarks(t.accuracy) }}%</span>
          </div>
          <p v-if="!stats.topics.length" class="muted">No data.</p>
        </ion-card-content>
      </ion-card>
    </template>

    <ion-list v-if="tab === 'questions' && stats">
      <ion-item v-for="(q, i) in stats.questions" :key="q.examQuestionId">
        <ion-label class="ion-text-wrap">
          <h3>Q{{ i + 1 }}. {{ q.text }}</h3>
          <p>
            {{ QUESTION_TYPE_LABELS[q.type] }} · attempted {{ q.attempted }} · correct {{ q.correct }} · avg
            {{ fmtMarks(q.averageMarks) }} / {{ fmtMarks(q.maxMarks) }}
          </p>
        </ion-label>
      </ion-item>
    </ion-list>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
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
  IonNote,
  IonSegment,
  IonSegmentButton,
  alertController,
  onIonViewWillEnter,
} from '@ionic/vue';
import { downloadOutline } from 'ionicons/icons';
import {
  QUESTION_TYPE_LABELS,
  type AttemptSummaryDto,
  type ExamAnalyticsDto,
  type ExamDetailDto,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { PHASE_COLORS, examsApi, fmtMarks, formatDate } from './api';

const route = useRoute();
const { can } = useAuthStore();
const id = computed(() => Number(route.params.id));
const exam = ref<ExamDetailDto | null>(null);
const stats = ref<ExamAnalyticsDto | null>(null);
const attempts = ref<AttemptSummaryDto[]>([]);
const tab = ref<'students' | 'topics' | 'questions'>('students');
const pending = computed(() => attempts.value.reduce((s, a) => s + a.pendingEvaluations, 0));
const maxBucket = computed(() => Math.max(1, ...(stats.value?.distribution.map((d) => d.count) ?? [1])));
const accClass = (a: number) => (a >= 70 ? 'good' : a >= 40 ? 'mid' : 'low');

async function load() {
  try {
    const [e, s, a] = await Promise.all([
      examsApi.get(id.value),
      examsApi.analytics(id.value),
      examsApi.attempts(id.value),
    ]);
    exam.value = e;
    stats.value = s;
    attempts.value = a;
  } catch (e) {
    await toastError(e);
  }
}
onIonViewWillEnter(load);

async function publish(on: boolean) {
  const a = await alertController.create({
    header: on ? 'Publish results?' : 'Unpublish results?',
    message: on
      ? 'Students and parents will see scores, ranks and answer keys, and will be notified.'
      : 'Results will be hidden from students and parents.',
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: on ? 'Publish' : 'Unpublish', role: 'confirm' },
    ],
  });
  await a.present();
  if ((await a.onDidDismiss()).role !== 'confirm') return;
  try {
    if (on) await examsApi.publish(id.value);
    else await examsApi.unpublish(id.value);
    await toast(on ? 'Results published' : 'Results unpublished');
    await load();
  } catch (e) {
    await toastError(e);
  }
}

async function exportCsv() {
  try {
    await examsApi.resultsCsv(id.value);
  } catch (e) {
    await toastError(e);
  }
}
</script>

<style scoped>
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
  gap: 8px;
}
.stats div {
  display: flex;
  flex-direction: column;
}
.stats strong {
  font-size: 1.3rem;
}
.stats span {
  font-size: 0.8rem;
  color: var(--ion-color-medium);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 12px;
}
.bar-row {
  display: grid;
  grid-template-columns: minmax(80px, 40%) 1fr 48px;
  gap: 8px;
  align-items: center;
  margin: 4px 0;
}
.lbl {
  font-size: 0.85rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.val {
  text-align: right;
  font-size: 0.85rem;
}
.bar {
  background: var(--ion-color-light);
  height: 10px;
  border-radius: 5px;
  overflow: hidden;
}
.bar div {
  height: 100%;
  background: var(--ion-color-primary);
}
.bar .good {
  background: var(--ion-color-success);
}
.bar .mid {
  background: var(--ion-color-warning);
}
.bar .low {
  background: var(--ion-color-danger);
}
</style>
