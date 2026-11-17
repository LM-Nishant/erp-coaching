<template>
  <AppPage :title="r ? r.exam.title : 'Result'" :back-href="backHref" :on-refresh="load">
    <template #actions>
      <ion-button
        v-if="r"
        :disabled="downloading"
        aria-label="Download scorecard (PDF)"
        @click="downloadScorecard"
      >
        <ion-icon slot="start" :icon="downloadOutline" /><span class="btn-text">Scorecard (PDF)</span>
      </ion-button>
    </template>

    <div v-if="loading && !r" class="ion-text-center ion-padding"><ion-spinner /></div>

    <template v-if="r">
      <!-- Summary -->
      <ion-card>
        <ion-card-header>
          <ion-card-subtitle>
            <span v-if="viewerMode !== 'student' && r.attempt.studentName"
              >{{ r.attempt.studentName }} ·
            </span>
            {{ formatDate(r.exam.startAt) }}
          </ion-card-subtitle>
          <ion-card-title
            >{{ fmtMarks(r.attempt.totalScore) }} / {{ fmtMarks(r.attempt.maxScore) }}</ion-card-title
          >
        </ion-card-header>
        <ion-card-content>
          <div class="chips">
            <ion-chip color="primary"
              ><ion-label>{{ percentage }}%</ion-label></ion-chip
            >
            <ion-chip v-if="r.attempt.rank" color="tertiary">
              <ion-icon :icon="trophyOutline" /><ion-label>Rank {{ r.attempt.rank }}</ion-label>
            </ion-chip>
            <ion-chip v-if="r.attempt.percentile !== null" color="secondary">
              <ion-label>{{ fmtMarks(r.attempt.percentile) }} percentile</ion-label>
            </ion-chip>
            <ion-chip v-if="r.passed !== null" :color="r.passed ? 'success' : 'danger'">
              <ion-label>{{ r.passed ? 'Passed' : 'Not passed' }}</ion-label>
            </ion-chip>
            <ion-chip v-if="r.attempt.pendingEvaluations" color="warning">
              <ion-label>{{ r.attempt.pendingEvaluations }} pending evaluation(s)</ion-label>
            </ion-chip>
          </div>
          <ion-list lines="none">
            <ion-item>
              <ion-label>Objective</ion-label>
              <ion-note slot="end">{{ fmtMarks(r.attempt.objectiveScore) }}</ion-note>
            </ion-item>
            <ion-item>
              <ion-label>Descriptive</ion-label>
              <ion-note slot="end">{{ fmtMarks(r.attempt.descriptiveScore) }}</ion-note>
            </ion-item>
            <ion-item v-if="r.exam.passMarks !== null">
              <ion-label>Pass marks</ion-label>
              <ion-note slot="end">{{ fmtMarks(r.exam.passMarks) }}</ion-note>
            </ion-item>
            <ion-item>
              <ion-label>Submitted</ion-label>
              <ion-note slot="end">
                {{ formatDate(r.attempt.submittedAt) }}
                <template v-if="r.attempt.status === 'auto_submitted'"> (auto)</template>
                <template v-else-if="r.attempt.status === 'in_progress'"> (in progress)</template>
              </ion-note>
            </ion-item>
          </ion-list>
        </ion-card-content>
      </ion-card>

      <!-- Sections -->
      <ion-card v-if="r.sections.length">
        <ion-card-header><ion-card-title>Sections</ion-card-title></ion-card-header>
        <ion-card-content>
          <div v-for="s in r.sections" :key="s.id" class="stat">
            <div class="stat-head">
              <span>{{ s.title }}</span>
              <span>{{ fmtMarks(s.score) }} / {{ fmtMarks(s.maxScore) }}</span>
            </div>
            <div class="bar">
              <div
                class="fill"
                :class="barClass(ratio(s.score, s.maxScore))"
                :style="barStyle(s.score, s.maxScore)"
              />
            </div>
          </div>
        </ion-card-content>
      </ion-card>

      <!-- Chapter / topic analytics -->
      <ion-card v-if="r.chapters.length">
        <ion-card-header><ion-card-title>Chapter &amp; topic performance</ion-card-title></ion-card-header>
        <ion-card-content>
          <div v-for="t in r.chapters" :key="t.key" class="stat">
            <div class="stat-head">
              <span>{{ topicLabel(t) }}</span>
              <span>{{ fmtMarks(t.score) }} / {{ fmtMarks(t.maxScore) }} · {{ fmtMarks(t.accuracy) }}%</span>
            </div>
            <div class="bar">
              <div class="fill" :class="barClass(t.accuracy)" :style="{ width: `${clamp(t.accuracy)}%` }" />
            </div>
          </div>
        </ion-card-content>
      </ion-card>

      <!-- Corrections (staff) -->
      <ion-card v-if="viewerMode === 'staff'">
        <ion-card-header><ion-card-title>Result corrections</ion-card-title></ion-card-header>
        <ion-card-content>
          <p v-if="!r.corrections.length" class="muted">No corrections have been made.</p>
          <ion-list v-else lines="full">
            <ion-item v-for="c in r.corrections" :key="c.id">
              <ion-label class="ion-text-wrap">
                <h3>
                  <template v-if="questionNoOfAnswer(c.answerId)"
                    >Q{{ questionNoOfAnswer(c.answerId) }}:
                  </template>
                  {{ fmtMarks(c.beforeMarks) }} → {{ fmtMarks(c.afterMarks) }}
                </h3>
                <p class="pre">{{ c.reason }}</p>
                <p class="muted">{{ c.correctedByName ?? 'Unknown' }} · {{ formatDate(c.createdAt) }}</p>
              </ion-label>
            </ion-item>
          </ion-list>
        </ion-card-content>
      </ion-card>

      <!-- Per-question review -->
      <ion-card v-for="(q, i) in r.questions" :key="q.examQuestionId">
        <ion-card-header>
          <ion-card-subtitle class="q-sub">
            <span>
              Q{{ i + 1 }} · {{ QUESTION_TYPE_LABELS[q.type] }}
              <template v-if="sectionTitle(q.sectionId)"> · {{ sectionTitle(q.sectionId) }}</template>
            </span>
            <ion-badge :color="verdict(q).color">{{ verdict(q).label }}</ion-badge>
          </ion-card-subtitle>
          <ion-card-title class="q-marks"
            >{{ fmtMarks(q.marks) }} / {{ fmtMarks(q.maxMarks) }} marks</ion-card-title
          >
        </ion-card-header>
        <ion-card-content>
          <p class="pre q-text">{{ q.text }}</p>
          <p v-if="q.chapterName || q.topicName" class="muted small">
            {{ [q.chapterName, q.topicName].filter(Boolean).join(' › ') }}
          </p>

          <!-- MCQ: show every option with the student's choice and the key -->
          <ion-list v-if="isMcq(q)" lines="none" class="options">
            <ion-item v-for="o in q.options" :key="o.key" :class="optionClass(q, o.key)">
              <ion-icon
                slot="start"
                :icon="isKey(q, o.key) ? checkmarkCircle : chosen(q, o.key) ? closeCircle : ellipseOutline"
              />
              <ion-label class="ion-text-wrap">
                <strong>{{ o.key }}.</strong> {{ o.text }}
                <p v-if="chosen(q, o.key)" class="small">Your answer</p>
              </ion-label>
            </ion-item>
            <p v-if="!responseText(q)" class="muted small">Not answered</p>
          </ion-list>

          <template v-else>
            <div class="block">
              <div class="block-label">{{ viewerMode === 'student' ? 'Your answer' : 'Response' }}</div>
              <p class="pre">{{ responseText(q) ?? 'Not answered' }}</p>
            </div>
            <div v-if="correctText(q)" class="block correct">
              <div class="block-label">
                {{ q.type === 'descriptive' ? 'Model answer' : 'Correct answer' }}
              </div>
              <p class="pre">{{ correctText(q) }}</p>
            </div>
          </template>

          <div v-if="q.pages.length" class="block">
            <div class="block-label">Handwritten pages</div>
            <div class="thumbs">
              <a v-for="p in q.pages" :key="p.id" :href="p.url" target="_blank" rel="noopener" class="thumb">
                <img
                  v-if="!broken[p.id]"
                  :src="p.url"
                  :alt="`Page ${p.pageNo}`"
                  @error="broken[p.id] = true"
                />
                <ion-icon v-else :icon="documentOutline" class="doc-icon" />
                <span>Page {{ p.pageNo }}</span>
              </a>
            </div>
          </div>

          <div v-if="q.feedback" class="block feedback">
            <div class="block-label">Evaluator feedback</div>
            <p class="pre">{{ q.feedback }}</p>
          </div>
          <div v-if="q.explanation" class="block">
            <div class="block-label">Explanation</div>
            <p class="pre">{{ q.explanation }}</p>
          </div>

          <ion-button
            v-if="canCorrect(q)"
            size="small"
            fill="outline"
            :disabled="busy"
            @click="correctMarks(q, i)"
          >
            <ion-icon slot="start" :icon="createOutline" />Correct marks
          </ion-button>
        </ion-card-content>
      </ion-card>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import {
  IonBadge,
  IonButton,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardSubtitle,
  IonCardTitle,
  IonChip,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonSpinner,
  alertController,
  onIonViewWillEnter,
} from '@ionic/vue';
import {
  checkmarkCircle,
  closeCircle,
  createOutline,
  documentOutline,
  downloadOutline,
  ellipseOutline,
  trophyOutline,
} from 'ionicons/icons';
import { QUESTION_TYPE_LABELS, type QuestionResultDto, type ResultDto, type TopicStat } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { examsApi, fmtMarks, formatDate } from './api';

const props = defineProps<{ viewer?: 'staff' }>();

const route = useRoute();
const auth = useAuthStore();

const r = ref<ResultDto | null>(null);
const loading = ref(true);
const busy = ref(false);
const downloading = ref(false);
const broken = reactive<Record<number, boolean>>({});

const attemptId = computed(() => Number(route.params.attemptId));
const examId = computed(() => Number(route.params.id));
const viewerMode = computed<'staff' | 'student' | 'parent'>(() =>
  props.viewer === 'staff' ? 'staff' : auth.can('exam-portal.create') ? 'student' : 'parent',
);
const backHref = computed(() =>
  viewerMode.value === 'staff' ? `/exams/${examId.value}/results` : '/exam-results',
);

const clamp = (n: number) => Math.max(0, Math.min(100, n));
const ratio = (score: number, max: number) => (max > 0 ? (Math.max(0, score) / max) * 100 : 0);
const percentage = computed(() =>
  r.value ? Math.round(ratio(r.value.attempt.totalScore, r.value.attempt.maxScore) * 10) / 10 : 0,
);
const barStyle = (score: number, max: number) => ({ width: `${clamp(ratio(score, max))}%` });
const barClass = (pct: number) => (pct >= 75 ? 'good' : pct >= 40 ? 'ok' : 'low');
const topicLabel = (t: TopicStat) =>
  `${t.chapterName ?? 'Uncategorised'}${t.topicName ? ` › ${t.topicName}` : ''}`;
const sectionTitle = (id: number) => r.value?.sections.find((s) => s.id === id)?.title ?? '';

function questionNoOfAnswer(answerId: number): number | null {
  const i = r.value?.questions.findIndex((q) => q.answerId === answerId) ?? -1;
  return i >= 0 ? i + 1 : null;
}

// ---------------------------------------------------------------- answer formatting

const isMcq = (q: QuestionResultDto) => q.type === 'single' || q.type === 'multiple';
const chosen = (q: QuestionResultDto, key: string) => !!q.response?.options?.includes(key);
const isKey = (q: QuestionResultDto, key: string) => !!q.correct?.options?.includes(key);

function optionClass(q: QuestionResultDto, key: string) {
  if (isKey(q, key)) return 'opt-correct';
  if (chosen(q, key)) return 'opt-wrong';
  return '';
}

const boolText = (v: boolean) => (v ? 'True' : 'False');

function responseText(q: QuestionResultDto): string | null {
  const res = q.response;
  if (!res) return null;
  switch (q.type) {
    case 'single':
    case 'multiple':
      return res.options?.length ? res.options.join(', ') : null;
    case 'numerical':
      return typeof res.value === 'number' ? String(res.value) : null;
    case 'true_false':
      return typeof res.value === 'boolean' ? boolText(res.value) : null;
    default:
      return res.text?.trim() || null;
  }
}

function correctText(q: QuestionResultDto): string | null {
  const k = q.correct;
  if (!k) return null;
  switch (q.type) {
    case 'numerical':
      if (k.min !== undefined && k.max !== undefined) return `Between ${k.min} and ${k.max}`;
      if (typeof k.value === 'number') return k.tolerance ? `${k.value} (± ${k.tolerance})` : String(k.value);
      return null;
    case 'true_false':
      return typeof k.value === 'boolean' ? boolText(k.value) : null;
    case 'descriptive':
      return k.modelAnswer?.trim() || null;
    default:
      return k.options?.join(', ') || null;
  }
}

function verdict(q: QuestionResultDto): { label: string; color: string } {
  if (q.type === 'descriptive') {
    if (q.marks === null) return { label: 'Pending evaluation', color: 'warning' };
    if (!responseText(q) && !q.pages.length) return { label: 'Not answered', color: 'medium' };
    return { label: 'Evaluated', color: 'primary' };
  }
  if (q.isCorrect) return { label: 'Correct', color: 'success' };
  if (!responseText(q)) return { label: 'Not answered', color: 'medium' };
  return { label: 'Incorrect', color: 'danger' };
}

// ---------------------------------------------------------------- data

async function load() {
  loading.value = true;
  try {
    const id = attemptId.value;
    if (viewerMode.value === 'staff') r.value = await examsApi.attemptResult(examId.value, id);
    else if (viewerMode.value === 'student') r.value = await examsApi.myResult(id);
    else r.value = await examsApi.childResult(id);
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}

async function downloadScorecard() {
  downloading.value = true;
  try {
    const id = attemptId.value;
    if (viewerMode.value === 'staff') await examsApi.staffScorecard(examId.value, id);
    else if (viewerMode.value === 'student') await examsApi.myScorecard(id);
    else await examsApi.childScorecard(id);
  } catch (e) {
    await toastError(e);
  } finally {
    downloading.value = false;
  }
}

// ---------------------------------------------------------------- staff corrections

const canCorrect = (q: QuestionResultDto) =>
  viewerMode.value === 'staff' &&
  auth.can('exams.publish') &&
  !!r.value &&
  r.value.attempt.status !== 'in_progress' &&
  q.answerId !== null;

async function correctMarks(q: QuestionResultDto, i: number) {
  if (q.answerId === null) return;
  const alert = await alertController.create({
    header: 'Correct marks',
    subHeader: `Q${i + 1} · current ${fmtMarks(q.marks)} / ${fmtMarks(q.maxMarks)}`,
    inputs: [
      {
        name: 'marks',
        type: 'number',
        placeholder: `Marks (up to ${fmtMarks(q.maxMarks)})`,
        value: q.marks ?? '',
        min: -q.maxMarks,
        max: q.maxMarks,
        attributes: { step: 'any', inputmode: 'decimal' },
      },
      { name: 'reason', type: 'textarea', placeholder: 'Reason for the correction (required)' },
    ],
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: 'Save', role: 'confirm' },
    ],
  });
  await alert.present();
  const { role, data } = await alert.onDidDismiss<{ values: { marks: string; reason: string } }>();
  if (role !== 'confirm' || !data) return;
  const rawMarks = String(data.values.marks ?? '').trim();
  const marks = Number(rawMarks);
  const reason = (data.values.reason ?? '').trim();
  if (rawMarks === '' || !Number.isFinite(marks) || marks < -q.maxMarks || marks > q.maxMarks) {
    await toast(`Marks must be a number up to ${fmtMarks(q.maxMarks)}`, 'warning');
    return;
  }
  if (!reason) {
    await toast('A reason is required', 'warning');
    return;
  }
  busy.value = true;
  try {
    r.value = await examsApi.correct(examId.value, { answerId: q.answerId, marks, reason });
    await toast('Result corrected');
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

onIonViewWillEnter(load);
</script>

<style scoped>
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 8px;
}
.stat {
  margin-bottom: 10px;
}
.stat-head {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 0.9rem;
  margin-bottom: 4px;
}
.bar {
  height: 8px;
  border-radius: 4px;
  background: var(--ion-color-light-shade);
  overflow: hidden;
}
.fill {
  height: 100%;
  border-radius: 4px;
}
.fill.good {
  background: var(--ion-color-success);
}
.fill.ok {
  background: var(--ion-color-warning);
}
.fill.low {
  background: var(--ion-color-danger);
}
.q-sub {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.q-marks {
  font-size: 1.05rem;
}
.q-text {
  font-size: 1rem;
  color: var(--ion-text-color);
}
.pre {
  white-space: pre-wrap;
}
.small {
  font-size: 0.8rem;
}
.options ion-item {
  --min-height: 36px;
}
.opt-correct {
  --color: var(--ion-color-success-shade);
}
.opt-correct ion-icon {
  color: var(--ion-color-success);
}
.opt-wrong {
  --color: var(--ion-color-danger-shade);
}
.opt-wrong ion-icon {
  color: var(--ion-color-danger);
}
.block {
  margin: 10px 0;
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--ion-color-light);
}
.block.correct {
  border-left: 3px solid var(--ion-color-success);
}
.block.feedback {
  border-left: 3px solid var(--ion-color-tertiary);
}
.block-label {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--ion-color-medium);
  margin-bottom: 4px;
}
.thumbs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.thumb {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 110px;
  font-size: 0.75rem;
  color: inherit;
  text-decoration: none;
}
.thumb img {
  width: 110px;
  height: 140px;
  object-fit: cover;
  border-radius: 4px;
  border: 1px solid var(--ion-color-light-shade);
}
.doc-icon {
  font-size: 64px;
  color: var(--ion-color-medium);
}
@media (max-width: 576px) {
  .btn-text {
    display: none;
  }
}
</style>
