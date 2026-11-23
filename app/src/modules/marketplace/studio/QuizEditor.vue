<template>
  <ion-header>
    <ion-toolbar>
      <ion-title>Quiz: {{ title }}</ion-title>
      <ion-buttons slot="end"><ion-button @click="emit('close')">Close</ion-button></ion-buttons>
    </ion-toolbar>
  </ion-header>
  <ion-content class="ion-padding">
    <div v-if="!loaded" class="center"><ion-spinner /></div>
    <template v-else>
      <ion-list>
        <ion-item>
          <ion-input
            v-model.number="form.passPercent"
            type="number"
            min="1"
            max="100"
            label="Pass mark (%)"
            label-placement="stacked"
            data-testid="quiz-pass-percent"
          />
        </ion-item>
        <ion-item>
          <ion-input
            v-model="form.maxAttempts"
            type="number"
            min="1"
            label="Attempts allowed (blank = unlimited)"
            label-placement="stacked"
            data-testid="quiz-max-attempts"
          />
        </ion-item>
        <ion-item>
          <ion-toggle v-model="form.shuffle">Shuffle question order for each learner</ion-toggle>
        </ion-item>
      </ion-list>

      <ion-card v-for="(q, qi) in form.questions" :key="q.uid" :data-testid="`quiz-question-${qi}`">
        <ion-card-header>
          <div class="row">
            <ion-card-subtitle>Question {{ qi + 1 }}</ion-card-subtitle>
            <ion-buttons>
              <ion-button :disabled="qi === 0" aria-label="Move question up" @click="move(qi, -1)">
                <ion-icon slot="icon-only" :icon="arrowUpOutline" />
              </ion-button>
              <ion-button
                :disabled="qi === form.questions.length - 1"
                aria-label="Move question down"
                @click="move(qi, 1)"
              >
                <ion-icon slot="icon-only" :icon="arrowDownOutline" />
              </ion-button>
              <ion-button color="danger" aria-label="Delete question" @click="form.questions.splice(qi, 1)">
                <ion-icon slot="icon-only" :icon="trashOutline" />
              </ion-button>
            </ion-buttons>
          </div>
        </ion-card-header>
        <ion-card-content>
          <ion-segment :value="q.kind" @ion-change="setKind(q, $event.detail.value as MktQuizQuestionKind)">
            <ion-segment-button value="single">One answer</ion-segment-button>
            <ion-segment-button value="multi" :data-testid="`quiz-kind-multi-${qi}`"
              >Several answers</ion-segment-button
            >
          </ion-segment>
          <ion-textarea
            v-model="q.prompt"
            label="Question"
            label-placement="stacked"
            auto-grow
            fill="outline"
            class="gap"
            :data-testid="`quiz-prompt-${qi}`"
          />
          <p class="muted">Tick the correct {{ q.kind === 'single' ? 'answer' : 'answers' }}.</p>
          <div v-for="(o, oi) in q.options" :key="oi" class="option">
            <ion-checkbox
              :checked="q.correct.includes(o.key)"
              :aria-label="`Option ${o.key} is correct`"
              :data-testid="`quiz-correct-${qi}-${oi}`"
              @ion-change="toggleCorrect(q, o.key, $event.detail.checked)"
            />
            <strong>{{ o.key }}</strong>
            <ion-input
              v-model="o.text"
              :aria-label="`Option ${o.key}`"
              placeholder="Answer text"
              fill="outline"
              :data-testid="`quiz-option-${qi}-${oi}`"
            />
            <ion-button
              fill="clear"
              color="medium"
              :disabled="q.options.length <= 2"
              aria-label="Remove option"
              @click="removeOption(q, oi)"
            >
              <ion-icon slot="icon-only" :icon="closeOutline" />
            </ion-button>
          </div>
          <ion-button
            fill="clear"
            size="small"
            :disabled="q.options.length >= MKT_QUIZ_MAX_OPTIONS"
            @click="addOption(q)"
          >
            <ion-icon slot="start" :icon="addOutline" /> Add option
          </ion-button>
          <ion-textarea
            v-model="q.explanation"
            label="Explanation shown after answering (optional)"
            label-placement="stacked"
            auto-grow
            fill="outline"
            :data-testid="`quiz-explanation-${qi}`"
          />
        </ion-card-content>
      </ion-card>

      <div class="buttons">
        <ion-button
          fill="outline"
          :disabled="form.questions.length >= MKT_QUIZ_MAX_QUESTIONS"
          data-testid="quiz-add-question"
          @click="addQuestion"
        >
          <ion-icon slot="start" :icon="addOutline" /> Add question
        </ion-button>
        <ion-button v-if="canImport" fill="outline" data-testid="quiz-import-open" @click="picking = true">
          <ion-icon slot="start" :icon="libraryOutline" /> Import from question bank
        </ion-button>
      </div>
      <p v-if="problem" class="error" data-testid="quiz-problem">{{ problem }}</p>
      <ion-button expand="block" :disabled="busy || !!problem" data-testid="quiz-save" @click="save()"
        >Save quiz</ion-button
      >
    </template>

    <ion-modal :is-open="picking" @did-dismiss="picking = false">
      <QuestionBankPicker v-if="picking" :busy="busy" @close="picking = false" @pick="importQuestions" />
    </ion-modal>
  </ion-content>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
  IonButton,
  IonButtons,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardSubtitle,
  IonCheckbox,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonList,
  IonModal,
  IonSegment,
  IonSegmentButton,
  IonSpinner,
  IonTextarea,
  IonTitle,
  IonToggle,
  IonToolbar,
} from '@ionic/vue';
import {
  addOutline,
  arrowDownOutline,
  arrowUpOutline,
  closeOutline,
  libraryOutline,
  trashOutline,
} from 'ionicons/icons';
import {
  MKT_QUIZ_DEFAULT_PASS_PERCENT,
  MKT_QUIZ_MAX_OPTIONS,
  MKT_QUIZ_MAX_QUESTIONS,
  type MktQuizDto,
  type MktQuizInput,
  type MktQuizQuestionKind,
} from '@erp/shared';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import QuestionBankPicker from './QuestionBankPicker.vue';
import { quizApi } from '../quiz-api';
import { quizProblem, type QuizDraftQuestion } from '../quiz-draft';
import type { StudioScope } from '../api';

const props = defineProps<{ scope: StudioScope; courseId: number; lectureId: number; title: string }>();
const emit = defineEmits<{ close: []; saved: [MktQuizDto] }>();
const auth = useAuthStore();
const studio = quizApi.studio(props.scope);
const canImport = props.scope === 'institute' && auth.can('question-bank.view');

const LETTERS = 'ABCDEFGH';
let uid = 0;
const loaded = ref(false);
const busy = ref(false);
const picking = ref(false);
const form = reactive({
  passPercent: MKT_QUIZ_DEFAULT_PASS_PERCENT,
  maxAttempts: '' as string | number,
  shuffle: false,
  questions: [] as QuizDraftQuestion[],
});
const problem = computed(() => quizProblem(form.questions, Number(form.passPercent)));

function fill(q: MktQuizDto) {
  form.passPercent = q.passPercent;
  form.maxAttempts = q.maxAttempts ?? '';
  form.shuffle = q.shuffle;
  form.questions = q.questions.map((x) => ({
    uid: ++uid,
    kind: x.kind,
    prompt: x.prompt,
    options: x.options.map((o) => ({ ...o })),
    correct: [...x.correct],
    explanation: x.explanation ?? '',
  }));
}

function addQuestion() {
  form.questions.push({
    uid: ++uid,
    kind: 'single',
    prompt: '',
    options: ['A', 'B', 'C', 'D'].map((key) => ({ key, text: '' })),
    correct: [],
    explanation: '',
  });
}
function move(i: number, by: number) {
  const q = form.questions;
  [q[i], q[i + by]] = [q[i + by]!, q[i]!];
}
function setKind(q: QuizDraftQuestion, kind: MktQuizQuestionKind) {
  q.kind = kind;
  if (kind === 'single') q.correct = q.correct.slice(0, 1);
}
function toggleCorrect(q: QuizDraftQuestion, key: string, on: boolean) {
  if (q.kind === 'single') q.correct = on ? [key] : q.correct.filter((k) => k !== key);
  else q.correct = on ? [...new Set([...q.correct, key])] : q.correct.filter((k) => k !== key);
}
function addOption(q: QuizDraftQuestion) {
  q.options.push({ key: LETTERS[q.options.length]!, text: '' });
}
/** Removing an option re-letters the rest so keys stay A, B, C… */
function removeOption(q: QuizDraftQuestion, i: number) {
  const correctOptions = new Set(q.options.filter((o) => q.correct.includes(o.key)));
  const kept = q.options.filter((_, k) => k !== i);
  q.correct = kept.flatMap((o, k) => (correctOptions.has(o) ? [LETTERS[k]!] : []));
  q.options = kept.map((o, k) => ({ key: LETTERS[k]!, text: o.text }));
}

function input(): MktQuizInput {
  const attempts = Number(form.maxAttempts);
  return {
    passPercent: Number(form.passPercent),
    maxAttempts: form.maxAttempts === '' || !attempts ? null : attempts,
    shuffle: form.shuffle,
    questions: form.questions.map((q) => ({
      kind: q.kind,
      prompt: q.prompt.trim(),
      options: q.options.map((o) => ({ key: o.key, text: o.text.trim() })),
      correct: q.correct,
      explanation: q.explanation.trim() || null,
    })),
  };
}

async function save(quiet = false) {
  busy.value = true;
  try {
    const saved = await studio.save(props.courseId, props.lectureId, input());
    fill(saved);
    emit('saved', saved);
    if (!quiet) await toast('Quiz saved');
    return true;
  } catch (e) {
    void toastError(e);
    return false;
  } finally {
    busy.value = false;
  }
}

/** Saves pending edits first: the import appends to the saved quiz. */
async function importQuestions(ids: number[]) {
  if (problem.value && form.questions.length) {
    void toastError(new Error(`Fix the quiz first: ${problem.value}`));
    return;
  }
  if (form.questions.length && !(await save(true))) return;
  busy.value = true;
  try {
    const saved = await studio.importFromBank(props.courseId, props.lectureId, ids);
    fill(saved);
    emit('saved', saved);
    picking.value = false;
    await toast(`${ids.length} question${ids.length === 1 ? '' : 's'} added`);
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  try {
    fill(await studio.get(props.courseId, props.lectureId));
    if (!form.questions.length) addQuestion();
  } catch (e) {
    void toastError(e);
  } finally {
    loaded.value = true;
  }
});
</script>

<style scoped>
.row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.option {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.gap {
  margin: 8px 0;
}
.buttons {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 8px 0;
}
.muted {
  color: var(--ion-color-medium);
  font-size: 13px;
}
.error {
  color: var(--ion-color-danger);
  font-size: 13px;
}
.center {
  text-align: center;
  padding: 40px;
}
</style>
