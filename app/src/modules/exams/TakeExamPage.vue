<template>
  <AppPage :title="session?.title ?? 'Exam'" back-href="/my-exams" :padded="false">
    <template #actions>
      <span v-if="session" class="save-state" :class="saveState" :title="SAVE_LABELS[saveState]">
        <ion-icon :icon="SAVE_ICONS[saveState]" />
        <span class="save-text">{{ SAVE_LABELS[saveState] }}</span>
      </span>
      <ion-chip v-if="session" :color="timerColor" class="timer">
        <ion-icon :icon="timeOutline" />
        <ion-label>{{ timerText }}</ion-label>
      </ion-chip>
      <ion-button
        v-if="session"
        class="palette-btn"
        aria-label="Question palette"
        @click="paletteOpen = true"
      >
        <ion-icon slot="icon-only" :icon="gridOutline" />
      </ion-button>
    </template>

    <div v-if="loading && !session" class="center ion-padding"><ion-spinner /></div>
    <div v-else-if="loadError && !session" class="center ion-padding">
      <p class="muted">{{ loadError }}</p>
      <ion-button @click="load">Retry</ion-button>
    </div>

    <div v-if="session && q && cur" class="exam-layout">
      <div class="exam-main">
        <ion-segment
          v-if="session.sections.length > 1"
          :value="q.sectionId"
          :scrollable="true"
          @ion-change="onSection($event.detail.value)"
        >
          <ion-segment-button v-for="s in session.sections" :key="s.id" :value="s.id">
            <ion-label>{{ s.title }}</ion-label>
          </ion-segment-button>
        </ion-segment>
        <p v-if="section?.instructions" class="muted section-instructions">{{ section.instructions }}</p>

        <div class="q-head">
          <strong>Question {{ index + 1 }} of {{ questions.length }}</strong>
          <ion-note>
            {{ QUESTION_TYPE_LABELS[q.type] }} · +{{ fmtMarks(q.marks)
            }}<template v-if="q.negativeMarks"> / −{{ fmtMarks(q.negativeMarks) }}</template>
          </ion-note>
        </div>
        <p class="q-text">{{ q.text }}</p>
        <div v-if="q.assets.length" class="assets">
          <img v-for="a in q.assets" :key="a.id" :src="a.url" alt="Question figure" />
        </div>

        <!-- Answer area -->
        <ion-radio-group
          v-if="q.type === 'single'"
          :value="cur.response?.options?.[0] ?? null"
          @ion-change="setOptions($event.detail.value ? [$event.detail.value] : [])"
        >
          <ion-item v-for="(o, i) in q.options" :key="o.key" lines="full">
            <ion-radio :value="o.key" justify="start" label-placement="end" class="ion-text-wrap">
              <span class="opt"
                ><strong>{{ letter(i) }}.</strong> {{ o.text }}
                <img v-if="o.imageUrl" :src="o.imageUrl" alt="" class="opt-img"
              /></span>
            </ion-radio>
          </ion-item>
        </ion-radio-group>

        <ion-list v-else-if="q.type === 'multiple'">
          <ion-item v-for="(o, i) in q.options" :key="o.key" lines="full">
            <ion-checkbox
              :checked="(cur.response?.options ?? []).includes(o.key)"
              justify="start"
              label-placement="end"
              class="ion-text-wrap"
              @ion-change="toggleOption(o.key, $event.detail.checked)"
            >
              <span class="opt"
                ><strong>{{ letter(i) }}.</strong> {{ o.text }}
                <img v-if="o.imageUrl" :src="o.imageUrl" alt="" class="opt-img"
              /></span>
            </ion-checkbox>
          </ion-item>
          <ion-note class="hint">Select all that apply.</ion-note>
        </ion-list>

        <ion-radio-group
          v-else-if="q.type === 'true_false'"
          :value="typeof cur.response?.value === 'boolean' ? String(cur.response.value) : null"
          @ion-change="setResponse({ value: $event.detail.value === 'true' })"
        >
          <ion-item lines="full">
            <ion-radio value="true" justify="start" label-placement="end">True</ion-radio>
          </ion-item>
          <ion-item lines="full">
            <ion-radio value="false" justify="start" label-placement="end">False</ion-radio>
          </ion-item>
        </ion-radio-group>

        <ion-item v-else-if="q.type === 'numerical'" lines="none">
          <ion-input
            type="number"
            inputmode="decimal"
            label="Your answer"
            label-placement="stacked"
            fill="outline"
            placeholder="Enter a number"
            :value="numDraft[q.examQuestionId] ?? numText(cur.response)"
            @ion-input="onNumber(String($event.detail.value ?? ''))"
          />
        </ion-item>

        <template v-else-if="q.type === 'descriptive'">
          <ion-textarea
            label="Your answer"
            label-placement="stacked"
            fill="outline"
            placeholder="Type your answer (optional if you upload handwritten pages)"
            :auto-grow="true"
            :rows="6"
            :maxlength="20000"
            :value="cur.response?.text ?? ''"
            @ion-input="setResponse({ text: String($event.detail.value ?? '') }, false)"
          />
          <ScanPagesPanel
            :attempt-id="attemptId"
            :exam-question-id="q.examQuestionId"
            :pages="cur.pages"
            :disabled="finished"
            @update:pages="cur.pages = $event"
            @closed="onClosed"
          />
        </template>

        <div class="q-tools">
          <ion-button
            size="small"
            :fill="cur.markedForReview ? 'solid' : 'outline'"
            color="tertiary"
            @click="toggleReview"
          >
            <ion-icon slot="start" :icon="cur.markedForReview ? bookmark : bookmarkOutline" />
            {{ cur.markedForReview ? 'Marked for review' : 'Mark for review' }}
          </ion-button>
          <ion-button
            size="small"
            fill="clear"
            color="medium"
            :disabled="!hasResponse(cur)"
            @click="clearResponse"
          >
            <ion-icon slot="start" :icon="closeCircleOutline" />Clear response
          </ion-button>
        </div>

        <div class="nav-bar">
          <ion-button fill="outline" :disabled="index === 0" @click="goTo(index - 1)">
            <ion-icon slot="start" :icon="chevronBack" />Previous
          </ion-button>
          <ion-button v-if="index < questions.length - 1" @click="goTo(index + 1)">
            Save &amp; next<ion-icon slot="end" :icon="chevronForward" />
          </ion-button>
          <ion-button v-else color="success" :disabled="finished" @click="confirmSubmit"
            >Submit exam</ion-button
          >
        </div>
      </div>

      <aside class="exam-side">
        <ExamQuestionPalette
          :items="paletteItems"
          :sections="session.sections"
          :current="index"
          @select="goTo"
        />
        <ion-button expand="block" color="success" :disabled="finished" @click="confirmSubmit"
          >Submit exam</ion-button
        >
      </aside>
    </div>

    <ion-modal :is-open="paletteOpen" @did-dismiss="paletteOpen = false">
      <ion-header>
        <ion-toolbar>
          <ion-title>Questions</ion-title>
          <ion-buttons slot="end"><ion-button @click="paletteOpen = false">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <ExamQuestionPalette
          v-if="session"
          :items="paletteItems"
          :sections="session.sections"
          :current="index"
          @select="selectFromModal"
        />
        <ion-button expand="block" color="success" :disabled="finished" @click="submitFromModal"
          >Submit exam</ion-button
        >
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  IonButton,
  IonButtons,
  IonCheckbox,
  IonChip,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonNote,
  IonRadio,
  IonRadioGroup,
  IonSegment,
  IonSegmentButton,
  IonSpinner,
  IonTextarea,
  IonTitle,
  IonToolbar,
  alertController,
  onIonViewWillEnter,
  onIonViewWillLeave,
} from '@ionic/vue';
import {
  bookmark,
  bookmarkOutline,
  checkmarkDoneOutline,
  chevronBack,
  chevronForward,
  closeCircleOutline,
  cloudOfflineOutline,
  cloudUploadOutline,
  createOutline,
  gridOutline,
  timeOutline,
} from 'ionicons/icons';
import {
  QUESTION_TYPE_LABELS,
  type AnswerPageDto,
  type AnswerResponse,
  type AttemptSessionDto,
  type DeliveredQuestion,
  type SaveAnswerInput,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { ApiError, errorMessage } from '@/core/api';
import { toast, toastError } from '@/core/toast';
import { examsApi, fmtMarks } from './api';
import ExamQuestionPalette, { type PaletteItem, type PaletteStatus } from './ExamQuestionPalette.vue';
import ScanPagesPanel from './ScanPagesPanel.vue';

interface LocalAnswer {
  response: AnswerResponse | null;
  markedForReview: boolean;
  visited: boolean;
  timeSpentSeconds: number;
  pages: AnswerPageDto[];
}

type SaveState = 'idle' | 'pending' | 'saving' | 'saved' | 'offline';

const SAVE_LABELS: Record<SaveState, string> = {
  idle: 'Ready',
  pending: 'Unsaved',
  saving: 'Saving…',
  saved: 'Saved',
  offline: 'Offline – will retry',
};
const SAVE_ICONS: Record<SaveState, string> = {
  idle: checkmarkDoneOutline,
  pending: createOutline,
  saving: cloudUploadOutline,
  saved: checkmarkDoneOutline,
  offline: cloudOfflineOutline,
};
const SAVE_DEBOUNCE_MS = 800;
const OFFLINE_RETRY_SECONDS = 15;
const WARN_MS = 5 * 60_000;

const route = useRoute();
const router = useRouter();

const attemptId = ref(Number(route.params.attemptId));
const session = ref<AttemptSessionDto | null>(null);
const answers = ref<Record<number, LocalAnswer>>({});
const numDraft = ref<Record<number, string>>({});
const index = ref(0);
const loading = ref(false);
const loadError = ref('');
const paletteOpen = ref(false);
const saveState = ref<SaveState>('idle');
const nowMs = ref(Date.now());
const deadlineMs = ref(0);
const finished = ref(false);

/** Server clock minus local clock, so the countdown is immune to a wrong device clock. */
let clockOffset = 0;
let tickTimer: ReturnType<typeof setInterval> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let retryCountdown = OFFLINE_RETRY_SECONDS;
/** Unsent changes per exam question, merged so the newest value of each field wins. */
const pending = new Map<number, SaveAnswerInput>();
let flushing: Promise<void> | null = null;
let closedHandled = false;

const questions = computed<DeliveredQuestion[]>(() => session.value?.questions ?? []);
const q = computed<DeliveredQuestion | undefined>(() => questions.value[index.value]);
const cur = computed<LocalAnswer | undefined>(() =>
  q.value ? answers.value[q.value.examQuestionId] : undefined,
);
const section = computed(() => session.value?.sections.find((s) => s.id === q.value?.sectionId));

const remainingMs = computed(() => Math.max(0, deadlineMs.value - nowMs.value));
const timerText = computed(() => {
  const total = Math.ceil(remainingMs.value / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
});
const timerColor = computed(() =>
  remainingMs.value <= 60_000 ? 'danger' : remainingMs.value <= WARN_MS ? 'warning' : 'primary',
);

const letter = (i: number) => String.fromCharCode(65 + i);
const numText = (r: AnswerResponse | null) => (typeof r?.value === 'number' ? String(r.value) : '');

function hasResponse(a: LocalAnswer | undefined): boolean {
  const r = a?.response;
  if (!r) return false;
  if (r.options) return r.options.length > 0;
  if (r.text !== undefined && r.text !== null) return r.text.trim().length > 0;
  return r.value !== undefined && r.value !== null;
}

function isAnswered(qq: DeliveredQuestion, a: LocalAnswer | undefined): boolean {
  if (!a) return false;
  if (qq.type === 'descriptive') return hasResponse(a) || a.pages.length > 0;
  return hasResponse(a);
}

function statusOf(qq: DeliveredQuestion): PaletteStatus {
  const a = answers.value[qq.examQuestionId];
  const answered = isAnswered(qq, a);
  if (a?.markedForReview) return answered ? 'answered-marked' : 'marked';
  if (answered) return 'answered';
  return a?.visited ? 'not-answered' : 'not-visited';
}

const paletteItems = computed<PaletteItem[]>(() =>
  questions.value.map((qq, i) => ({ index: i, sectionId: qq.sectionId, status: statusOf(qq) })),
);

// ---------------------------------------------------------------- loading & sync

function syncClock(serverNow: string, deadlineAt: string) {
  clockOffset = Date.parse(serverNow) - Date.now();
  deadlineMs.value = Date.parse(deadlineAt);
  nowMs.value = Date.now() + clockOffset;
}

/** Applies a server session; unsent local edits (still in `pending`) win over the server copy. */
function applySession(s: AttemptSessionDto) {
  session.value = s;
  syncClock(s.serverNow, s.deadlineAt);
  const saved = new Map(s.answers.map((a) => [a.examQuestionId, a]));
  const next: Record<number, LocalAnswer> = {};
  for (const qq of s.questions) {
    const id = qq.examQuestionId;
    const server = saved.get(id);
    const local = answers.value[id];
    const unsent = pending.get(id);
    next[id] = {
      response: unsent?.response !== undefined ? (local?.response ?? null) : (server?.response ?? null),
      markedForReview:
        unsent?.markedForReview !== undefined ? !!local?.markedForReview : (server?.markedForReview ?? false),
      visited: !!(server?.visited || local?.visited),
      timeSpentSeconds: Math.max(server?.timeSpentSeconds ?? 0, local?.timeSpentSeconds ?? 0),
      pages: server?.pages ?? [],
    };
    if (unsent?.response === undefined) delete numDraft.value[id];
  }
  answers.value = next;
  if (index.value >= s.questions.length) index.value = 0;
}

async function load() {
  attemptId.value = Number(route.params.attemptId);
  loading.value = true;
  loadError.value = '';
  try {
    const s = await examsApi.resume(attemptId.value);
    const first = !session.value || session.value.attemptId !== s.attemptId;
    if (first) {
      answers.value = {};
      numDraft.value = {};
      pending.clear();
    }
    applySession(s);
    if (first) {
      const unvisited = s.questions.findIndex((qq) => !answers.value[qq.examQuestionId]?.visited);
      index.value = unvisited > 0 ? unvisited : 0;
    }
    markVisited();
    saveState.value = navigator.onLine ? 'idle' : 'offline';
  } catch (e) {
    if (isClosed(e)) await onClosed(e);
    else {
      loadError.value = errorMessage(e);
      await toastError(e);
    }
  } finally {
    loading.value = false;
  }
}

async function resync() {
  if (finished.value || !session.value) return;
  await flush();
  if (finished.value) return;
  try {
    applySession(await examsApi.resume(attemptId.value));
  } catch (e) {
    if (isClosed(e)) await onClosed(e);
  }
}

// ---------------------------------------------------------------- saving

const isClosed = (e: unknown): e is ApiError =>
  e instanceof ApiError && e.status === 409 && e.code === 'ATTEMPT_CLOSED';

async function onClosed(e: ApiError) {
  if (closedHandled) return;
  closedHandled = true;
  finished.value = true;
  stopTimers();
  pending.clear();
  await toast(e.message || 'This exam has been submitted', 'warning');
  await router.replace('/my-exams');
}

function queue(id: number, patch: SaveAnswerInput, immediate = false) {
  if (finished.value) return;
  pending.set(id, { ...pending.get(id), ...patch, timeSpentSeconds: answers.value[id]?.timeSpentSeconds });
  if (saveState.value !== 'offline') saveState.value = 'pending';
  clearTimeout(saveTimer);
  if (immediate) void flush();
  else saveTimer = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
}

async function flush(): Promise<void> {
  clearTimeout(saveTimer);
  if (flushing) {
    await flushing;
    if (pending.size && saveState.value !== 'offline') return flush();
    return;
  }
  if (!pending.size || closedHandled) return;
  flushing = (async () => {
    saveState.value = 'saving';
    for (const [id, body] of [...pending]) {
      pending.delete(id);
      try {
        const r = await examsApi.save(attemptId.value, id, body);
        syncClock(r.serverNow, r.deadlineAt);
      } catch (e) {
        if (e instanceof ApiError && e.status === 0) {
          // Keep it (newer edits made meanwhile take precedence) and retry when back online.
          pending.set(id, { ...body, ...pending.get(id) });
          saveState.value = 'offline';
          retryCountdown = OFFLINE_RETRY_SECONDS;
          return;
        }
        if (isClosed(e)) {
          await onClosed(e);
          return;
        }
        await toastError(e);
      }
    }
    saveState.value = pending.size ? 'pending' : 'saved';
  })();
  try {
    await flushing;
  } finally {
    flushing = null;
  }
}

// ---------------------------------------------------------------- answering & navigation

function setResponse(response: AnswerResponse | null, immediate = true) {
  const id = q.value?.examQuestionId;
  if (id === undefined || !cur.value || finished.value) return;
  cur.value.response = response;
  queue(id, { response }, immediate);
}

function setOptions(options: string[]) {
  setResponse({ options });
}

function toggleOption(key: string, checked: boolean) {
  const chosen = new Set(cur.value?.response?.options ?? []);
  if (checked) chosen.add(key);
  else chosen.delete(key);
  // Keep delivered order so the payload is stable.
  setOptions(q.value!.options.map((o) => o.key).filter((k) => chosen.has(k)));
}

function onNumber(raw: string) {
  const id = q.value!.examQuestionId;
  numDraft.value[id] = raw;
  const text = raw.trim();
  if (text === '') return setResponse({ value: null }, false);
  const n = Number(text);
  if (Number.isFinite(n)) setResponse({ value: n }, false);
}

function clearResponse() {
  if (!q.value) return;
  delete numDraft.value[q.value.examQuestionId];
  setResponse(null);
}

function toggleReview() {
  if (!q.value || !cur.value) return;
  cur.value.markedForReview = !cur.value.markedForReview;
  queue(q.value.examQuestionId, { markedForReview: cur.value.markedForReview }, true);
}

function markVisited() {
  if (!q.value || !cur.value || cur.value.visited) return;
  cur.value.visited = true;
  queue(q.value.examQuestionId, { visited: true }, true);
}

function goTo(i: number) {
  if (i < 0 || i >= questions.value.length || i === index.value) return;
  if (q.value) queue(q.value.examQuestionId, {}, false);
  index.value = i;
  markVisited();
  void flush();
}

function onSection(value: string | number | undefined) {
  const sectionId = Number(value);
  if (q.value?.sectionId === sectionId) return;
  const i = questions.value.findIndex((qq) => qq.sectionId === sectionId);
  if (i >= 0) goTo(i);
}

function selectFromModal(i: number) {
  paletteOpen.value = false;
  goTo(i);
}

// ---------------------------------------------------------------- submit

async function confirmSubmit() {
  const counts = { answered: 0, unanswered: 0, marked: 0 };
  for (const qq of questions.value) {
    const a = answers.value[qq.examQuestionId];
    if (isAnswered(qq, a)) counts.answered++;
    else counts.unanswered++;
    if (a?.markedForReview) counts.marked++;
  }
  const lines = [`Answered: ${counts.answered} of ${questions.value.length}.`];
  if (counts.unanswered) lines.push(`${counts.unanswered} question(s) are not answered.`);
  if (counts.marked) lines.push(`${counts.marked} question(s) are marked for review.`);
  lines.push('You cannot change your answers after submitting.');
  const alert = await alertController.create({
    header: 'Submit exam?',
    message: lines.join(' '),
    buttons: [
      { text: 'Keep working', role: 'cancel' },
      { text: 'Submit', role: 'confirm' },
    ],
  });
  await alert.present();
  if ((await alert.onDidDismiss()).role === 'confirm') await finish(false);
}

async function submitFromModal() {
  paletteOpen.value = false;
  await confirmSubmit();
}

async function finish(auto: boolean) {
  if (finished.value) return;
  finished.value = true;
  stopTimers();
  // `queue` is a no-op once finished, so record the final time spent directly.
  if (q.value && cur.value)
    pending.set(q.value.examQuestionId, {
      ...pending.get(q.value.examQuestionId),
      timeSpentSeconds: cur.value.timeSpentSeconds,
    });
  await flush();
  if (closedHandled) return;
  try {
    await examsApi.submit(attemptId.value);
    await toast(auto ? "Time's up – your exam has been submitted" : 'Exam submitted');
  } catch (e) {
    if (isClosed(e)) await toast('Your exam has already been submitted', 'medium');
    else if (auto) await toast('Time is up. Your saved answers will be submitted automatically.', 'warning');
    else {
      finished.value = false;
      startTimers();
      await toastError(e);
      return;
    }
  }
  pending.clear();
  await router.replace('/my-exams');
}

// ---------------------------------------------------------------- lifecycle

function tick() {
  nowMs.value = Date.now() + clockOffset;
  if (!session.value || finished.value) return;
  if (cur.value && document.visibilityState === 'visible') cur.value.timeSpentSeconds++;
  if (remainingMs.value <= 0) {
    void finish(true);
    return;
  }
  if (saveState.value === 'offline' && pending.size && --retryCountdown <= 0) {
    retryCountdown = OFFLINE_RETRY_SECONDS;
    void flush();
  }
}

function onOnline() {
  if (saveState.value === 'offline') saveState.value = pending.size ? 'pending' : 'saved';
  void resync();
}

function onOffline() {
  saveState.value = 'offline';
}

function startTimers() {
  stopTimers();
  tickTimer = setInterval(tick, 1000);
}

function stopTimers() {
  clearInterval(tickTimer);
  tickTimer = undefined;
}

onIonViewWillEnter(async () => {
  finished.value = false;
  closedHandled = false;
  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  await load();
  if (!finished.value && session.value) startTimers();
});

onIonViewWillLeave(() => {
  stopTimers();
  window.removeEventListener('online', onOnline);
  window.removeEventListener('offline', onOffline);
  paletteOpen.value = false;
  if (!finished.value && q.value) {
    queue(q.value.examQuestionId, {}, true);
  }
});
</script>

<style scoped>
.center {
  text-align: center;
}
.exam-layout {
  display: flex;
  gap: 16px;
  align-items: flex-start;
}
.exam-main {
  flex: 1;
  min-width: 0;
  padding: 12px 16px 24px;
}
.exam-side {
  width: 280px;
  position: sticky;
  top: 0;
  padding: 12px;
  border-left: 1px solid var(--ion-color-light-shade);
  display: none;
}
@media (min-width: 992px) {
  .exam-side {
    display: block;
  }
  .palette-btn {
    display: none;
  }
}
.section-instructions {
  white-space: pre-wrap;
  font-size: 0.9rem;
}
.q-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 12px;
}
.q-text {
  white-space: pre-wrap;
  font-size: 1.05rem;
  line-height: 1.5;
}
.assets img,
.opt-img {
  display: block;
  max-width: 100%;
  max-height: 320px;
  margin: 6px 0;
  border-radius: 4px;
}
.opt {
  white-space: normal;
}
.hint {
  display: block;
  padding: 6px 16px;
}
.q-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}
.nav-bar {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--ion-color-light-shade);
}
.timer {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.save-state {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 0.8rem;
  color: var(--ion-color-medium);
  margin-right: 4px;
}
.save-state.saved {
  color: var(--ion-color-success);
}
.save-state.offline {
  color: var(--ion-color-danger);
}
@media (max-width: 576px) {
  .save-text {
    display: none;
  }
}
</style>
