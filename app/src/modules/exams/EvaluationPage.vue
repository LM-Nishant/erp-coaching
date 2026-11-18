<template>
  <AppPage title="Evaluate answers" :back-href="`/exams/${id}`" :on-refresh="load">
    <template #actions>
      <ion-button v-if="aiMode" :disabled="aiBlocked" @click="runAi(false)">
        <ion-icon slot="start" :icon="sparklesOutline" />AI grade
      </ion-button>
    </template>

    <div v-if="aiMode && aiNotice" class="notice" :class="aiNotice.color">
      <ion-icon :icon="aiNotice.color === 'danger' ? alertCircleOutline : sparklesOutline" />
      <span
        >{{ aiNotice.text }}
        <template v-if="exam?.evaluationMode === 'ai_only'">
          AI-only exam: AI marks are final unless a teacher overrides them.</template
        ></span
      >
    </div>

    <ion-segment v-model="status" @ion-change="loadEvaluations">
      <ion-segment-button value=""><ion-label>All</ion-label></ion-segment-button>
      <ion-segment-button v-for="s in EVALUATION_STATUSES" :key="s" :value="s">
        <ion-label>{{ s.replace('_', ' ') }}</ion-label>
      </ion-segment-button>
    </ion-segment>

    <ion-card v-if="jobs.length">
      <ion-card-header><ion-card-subtitle>AI grading jobs</ion-card-subtitle></ion-card-header>
      <ion-card-content>
        <p v-for="j in jobs.slice(0, 5)" :key="j.id">
          #{{ j.id }} · <ion-badge :color="JOB_COLORS[j.status]">{{ j.status }}</ion-badge>
          {{ j.processed }}/{{ j.total }} processed<span v-if="j.failed">, {{ j.failed }} failed</span> ·
          {{ formatDate(j.createdAt) }}
          <span v-if="j.model" class="muted">
            · {{ j.provider }} · {{ j.model }} · {{ formatTokens(j.totalTokens) }} tokens<span
              v-if="j.imageCount"
            >
              · {{ j.imageCount }} images</span
            >
            · est. {{ formatUsd(j.estimatedCostUsd) }}</span
          >
          <ion-badge v-if="j.provider === 'mock'" color="warning">simulated</ion-badge>
          <span v-if="j.error" class="error"> — {{ j.error }}</span>
        </p>
        <ion-button size="small" fill="clear" :disabled="aiBlocked" @click="runAi(true)"
          >Re-grade everything not finalized</ion-button
        >
      </ion-card-content>
    </ion-card>

    <p v-if="!items.length" class="ion-padding muted">Nothing to evaluate for this filter.</p>

    <ion-card v-for="ev in items" :key="ev.answerId">
      <ion-card-header>
        <ion-card-subtitle>
          {{ ev.studentName ?? `Student #${ev.studentUserId}` }} ·
          <ion-badge :color="EVAL_STATUS_COLORS[ev.status]">{{ ev.status.replace('_', ' ') }}</ion-badge>
          · max {{ fmtMarks(ev.maxMarks) }}
        </ion-card-subtitle>
        <ion-card-title class="q">{{ ev.questionText }}</ion-card-title>
      </ion-card-header>
      <ion-card-content>
        <details v-if="ev.modelAnswer || ev.rubric">
          <summary>Model answer &amp; rubric</summary>
          <p v-if="ev.modelAnswer"><strong>Model answer:</strong> {{ ev.modelAnswer }}</p>
          <p v-if="ev.rubric"><strong>Rubric:</strong> {{ ev.rubric }}</p>
        </details>
        <h3>Submission</h3>
        <p v-if="ev.responseText" class="response">{{ ev.responseText }}</p>
        <div v-if="ev.pages.length" class="pages">
          <a v-for="p in ev.pages" :key="p.id" :href="p.url" target="_blank" rel="noopener">
            <img :src="p.url" :alt="`Page ${p.pageNo}`" />
            <span>Page {{ p.pageNo }}</span>
          </a>
        </div>
        <p v-if="!ev.responseText && !ev.pages.length" class="muted">No answer submitted.</p>

        <div v-if="ev.aiMarks !== null" class="ai">
          <strong
            >{{ exam?.evaluationMode === 'ai_only' ? 'AI marks' : 'AI suggestion' }}:
            {{ fmtMarks(ev.aiMarks) }} / {{ fmtMarks(ev.maxMarks) }}</strong
          >
          <span v-if="ev.aiConfidence !== null"> · confidence {{ Math.round(ev.aiConfidence * 100) }}%</span>
          <span v-if="ev.aiModel" class="muted"> · {{ ev.aiProvider }} · {{ ev.aiModel }}</span>
          <ion-badge v-if="ev.aiProvider === 'mock'" color="warning">simulated</ion-badge>
          <p v-if="ev.aiFeedback">{{ ev.aiFeedback }}</p>
        </div>
        <p v-if="ev.finalMarks !== null" class="muted">
          Final: {{ fmtMarks(ev.finalMarks) }}
          <span v-if="ev.evaluatedByName"
            >by {{ ev.evaluatedByName }} · {{ formatDate(ev.evaluatedAt) }}</span
          >
        </p>

        <template v-if="!published">
          <ion-item>
            <ion-input
              v-model.number="draft(ev).marks"
              type="number"
              :min="0"
              :max="ev.maxMarks"
              label="Marks"
              label-placement="stacked"
            />
          </ion-item>
          <ion-item>
            <ion-textarea v-model="draft(ev).feedback" label="Feedback" label-placement="stacked" auto-grow />
          </ion-item>
          <div class="row">
            <ion-button size="small" @click="save(ev)">Save marks</ion-button>
            <ion-button v-if="ev.aiMarks !== null" size="small" fill="outline" @click="acceptAi(ev)"
              >Accept AI</ion-button
            >
            <ion-button size="small" fill="clear" @click="openHistory(ev)">History</ion-button>
          </div>
        </template>
        <template v-else>
          <p class="muted">Results are published — use result correction on the results page.</p>
          <ion-button size="small" fill="clear" @click="openHistory(ev)">History</ion-button>
        </template>
      </ion-card-content>
    </ion-card>

    <ion-modal :is-open="!!history" @did-dismiss="history = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>Answer history</ion-title>
          <ion-buttons slot="end"><ion-button @click="history = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content v-if="history" class="ion-padding">
        <h3>Original submission</h3>
        <p class="muted">Submitted {{ formatDate(history.submission.submittedAt) }}</p>
        <p v-if="history.submission.responseText" class="response">{{ history.submission.responseText }}</p>
        <div v-if="history.submission.pages.length" class="pages">
          <a v-for="p in history.submission.pages" :key="p.id" :href="p.url" target="_blank" rel="noopener">
            <img :src="p.url" :alt="`Page ${p.pageNo}`" />
            <span>Page {{ p.pageNo }}</span>
          </a>
        </div>
        <p v-if="!history.submission.responseText && !history.submission.pages.length" class="muted">
          No answer submitted.
        </p>

        <h3>Marks</h3>
        <p>
          Counted now: <strong>{{ fmtMarks(history.current.effectiveMarks) }}</strong> /
          {{ fmtMarks(history.maxMarks) }} · AI {{ fmtMarks(history.current.aiMarks) }} · teacher
          {{ fmtMarks(history.current.teacherMarks) }} · final {{ fmtMarks(history.current.finalMarks) }}
        </p>
        <p v-if="history.published" class="muted">
          Last published {{ formatDate(history.published.at) }}: {{ fmtMarks(history.published.marks) }} marks
          (attempt total {{ fmtMarks(history.published.attemptTotal) }})
        </p>

        <h3>Marks trail</h3>
        <ion-list>
          <ion-item v-for="r in history.revisions" :key="r.id">
            <ion-label class="ion-text-wrap">
              <h3>
                {{ REVISION_LABELS[r.kind] }}:
                <template v-if="r.previousMarks !== null">{{ fmtMarks(r.previousMarks) }} → </template
                >{{ fmtMarks(r.marks) }}
              </h3>
              <p>{{ formatDate(r.createdAt) }} · {{ revisionBy(r) }}</p>
              <p v-if="revisionNote(r)">{{ revisionNote(r) }}</p>
              <p v-if="r.feedback">{{ r.feedback }}</p>
            </ion-label>
          </ion-item>
        </ion-list>
        <p v-if="!history.revisions.length" class="muted">No marks recorded yet.</p>

        <template v-if="history.corrections.length">
          <h3>Result corrections</h3>
          <p v-for="c in history.corrections" :key="c.id">
            {{ formatDate(c.createdAt) }} · {{ fmtMarks(c.beforeMarks) }} → {{ fmtMarks(c.afterMarks) }} ·
            {{ c.correctedByName ?? 'unknown' }}: {{ c.reason }}
          </p>
        </template>

        <h3>AI calls</h3>
        <ion-card v-for="h in history.aiResults" :key="h.id">
          <ion-card-header>
            <ion-card-subtitle>
              {{ formatDate(h.createdAt) }} · {{ h.provider ?? 'unknown' }} ·
              {{ h.model ?? 'unknown model' }} ·
              <ion-badge :color="h.status === 'success' ? 'success' : 'danger'">{{ h.status }}</ion-badge>
              <ion-badge v-if="h.provider === 'mock'" color="warning">simulated</ion-badge>
              <span v-if="h.usedVision"> · vision</span>
              <span v-if="h.promptVersionId"> · prompt v#{{ h.promptVersionId }}</span>
            </ion-card-subtitle>
          </ion-card-header>
          <ion-card-content>
            <p v-if="h.marks !== null">
              Marks: {{ fmtMarks(h.marks) }}
              <span v-if="h.confidence !== null"> · confidence {{ Math.round(h.confidence * 100) }}%</span>
            </p>
            <p v-if="h.feedback">{{ h.feedback }}</p>
            <p class="muted">
              {{ formatTokens(h.totalTokens) }} tokens ({{ formatTokens(h.promptTokens) }} in,
              {{ formatTokens(h.completionTokens) }} out)<span v-if="h.imageCount">
                · {{ h.imageCount }} images</span
              >
              · est. {{ formatUsd(h.estimatedCostUsd)
              }}<span v-if="h.latencyMs !== null"> · {{ h.latencyMs }} ms</span>
            </p>
            <p v-if="h.error" class="error">{{ h.error }}</p>
            <details v-if="h.rawOutput">
              <summary>Raw output</summary>
              <pre>{{ h.rawOutput }}</pre>
            </details>
          </ion-card-content>
        </ion-card>
        <p v-if="!history.aiResults.length" class="muted">No AI runs for this answer.</p>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardSubtitle,
  IonCardTitle,
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
  IonTextarea,
  IonTitle,
  IonToolbar,
  onIonViewWillEnter,
} from '@ionic/vue';
import { alertCircleOutline, sparklesOutline } from 'ionicons/icons';
import {
  EVALUATION_STATUSES,
  type AiAvailabilityDto,
  type AnswerHistoryDto,
  type EvaluationDto,
  type EvaluationStatus,
  type ExamDetailDto,
  type GradingJobDto,
  type GradingJobStatus,
  type MarkRevisionDto,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { aiAvailabilityNotice, formatTokens, formatUsd } from '@/core/ai';
import { toast, toastError } from '@/core/toast';
import { EVAL_STATUS_COLORS, REVISION_LABELS, examsApi, fmtMarks, formatDate } from './api';

const JOB_COLORS: Record<GradingJobStatus, string> = {
  queued: 'medium',
  running: 'primary',
  completed: 'success',
  failed: 'danger',
};

const route = useRoute();
const id = computed(() => Number(route.params.id));
const exam = ref<ExamDetailDto | null>(null);
const items = ref<EvaluationDto[]>([]);
const jobs = ref<GradingJobDto[]>([]);
const status = ref<EvaluationStatus | ''>('pending');
const drafts = reactive<Record<number, { marks: number | null; feedback: string }>>({});
const history = ref<AnswerHistoryDto | null>(null);
const aiStatus = ref<AiAvailabilityDto | null>(null);
const published = computed(() => !!exam.value?.resultsPublishedAt);
const aiMode = computed(() => !!exam.value && exam.value.evaluationMode !== 'manual');
const aiBlocked = computed(() => aiStatus.value?.available === false);
const aiNotice = computed(() => (aiStatus.value ? aiAvailabilityNotice(aiStatus.value) : null));

function draft(ev: EvaluationDto) {
  if (!drafts[ev.answerId]) {
    drafts[ev.answerId] = {
      marks: ev.teacherMarks ?? ev.finalMarks ?? ev.aiMarks,
      feedback: ev.teacherFeedback ?? ev.aiFeedback ?? '',
    };
  }
  return drafts[ev.answerId];
}

async function loadEvaluations() {
  try {
    items.value = await examsApi.evaluations(id.value, { status: status.value });
    for (const k of Object.keys(drafts)) delete drafts[Number(k)];
  } catch (e) {
    await toastError(e);
  }
}

async function load() {
  try {
    const [e, j] = await Promise.all([examsApi.get(id.value), examsApi.gradingJobs(id.value)]);
    exam.value = e;
    jobs.value = j;
    aiStatus.value = e.evaluationMode === 'manual' ? null : await examsApi.aiStatus();
  } catch (e) {
    await toastError(e);
  }
  await loadEvaluations();
}
onIonViewWillEnter(load);

function replace(ev: EvaluationDto) {
  const i = items.value.findIndex((x) => x.answerId === ev.answerId);
  if (i >= 0) items.value[i] = ev;
  delete drafts[ev.answerId];
}

async function save(ev: EvaluationDto) {
  const d = draft(ev);
  if (typeof d.marks !== 'number' || !Number.isFinite(d.marks) || d.marks < 0 || d.marks > ev.maxMarks) {
    await toast(`Marks must be between 0 and ${ev.maxMarks}`);
    return;
  }
  try {
    replace(await examsApi.evaluate(id.value, ev.answerId, { marks: d.marks, feedback: d.feedback || null }));
    await toast('Saved');
  } catch (e) {
    await toastError(e);
  }
}

async function acceptAi(ev: EvaluationDto) {
  try {
    replace(await examsApi.evaluate(id.value, ev.answerId, { acceptAi: true }));
    await toast('AI marks accepted');
  } catch (e) {
    await toastError(e);
  }
}

async function runAi(regrade: boolean) {
  try {
    const job = await examsApi.startGrading(id.value, regrade);
    jobs.value = [job, ...jobs.value.filter((j) => j.id !== job.id)];
    await toast('AI grading queued — refresh in a moment to see suggestions');
  } catch (e) {
    await toastError(e);
  }
  aiStatus.value = await examsApi.aiStatus().catch(() => aiStatus.value);
}

async function openHistory(ev: EvaluationDto) {
  try {
    history.value = await examsApi.answerHistory(id.value, ev.answerId);
  } catch (e) {
    await toastError(e);
  }
}

function revisionBy(r: MarkRevisionDto) {
  if (r.actorName) return r.actorName;
  const m = r.metadata ?? {};
  if (r.source === 'ai')
    return [m.provider, m.model].filter((x) => typeof x === 'string').join(' · ') || 'AI';
  return 'System';
}

function revisionNote(r: MarkRevisionDto): string | null {
  const m = r.metadata ?? {};
  if (typeof m.reason === 'string') return `Reason: ${m.reason}`;
  if (typeof m.attemptTotal === 'number') return `Attempt total ${fmtMarks(m.attemptTotal)}`;
  if (typeof m.confidence === 'number') return `Confidence ${Math.round(m.confidence * 100)}%`;
  return null;
}
</script>

<style scoped>
.q {
  font-size: 1rem;
  white-space: pre-wrap;
}
.response {
  white-space: pre-wrap;
  background: var(--ion-color-light);
  padding: 8px;
  border-radius: 6px;
}
.pages {
  display: flex;
  gap: 8px;
  overflow-x: auto;
}
.pages a {
  display: flex;
  flex-direction: column;
  align-items: center;
  font-size: 0.8rem;
}
.pages img {
  max-height: 220px;
  border: 1px solid var(--ion-color-medium);
  border-radius: 4px;
}
.ai {
  margin-top: 8px;
  padding: 8px;
  border-left: 3px solid var(--ion-color-tertiary);
}
.row {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.error {
  color: var(--ion-color-danger);
}
pre {
  white-space: pre-wrap;
  font-size: 0.75rem;
}
</style>
