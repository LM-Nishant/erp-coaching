<template>
  <div class="quiz" data-testid="quiz-player">
    <div v-if="!quiz" class="center"><ion-spinner /></div>

    <!-- Result of the latest (or a past) attempt -->
    <template v-else-if="result">
      <div :class="['banner', result.passed ? 'pass' : 'fail']" data-testid="quiz-result">
        <h3>{{ result.passed ? 'Passed' : 'Not passed yet' }}</h3>
        <p>
          You scored <strong data-testid="quiz-score">{{ result.percent }}%</strong> ({{ result.score }} of
          {{ result.total }}). The pass mark is {{ result.passPercent }}%.
        </p>
      </div>
      <ol class="questions">
        <li
          v-for="q in result.questions"
          :key="q.id"
          :class="q.isCorrect ? 'right' : 'wrong'"
          :data-testid="`quiz-review-${q.id}`"
        >
          <p class="prompt">
            <ion-icon
              :icon="q.isCorrect ? checkmarkCircle : closeCircle"
              :color="q.isCorrect ? 'success' : 'danger'"
            />
            {{ q.prompt }}
          </p>
          <ul class="options">
            <li
              v-for="o in q.options"
              :key="o.key"
              :class="{ correct: q.correct.includes(o.key), chosen: q.chosen.includes(o.key) }"
            >
              <strong>{{ o.key }}.</strong> {{ o.text }}
              <span v-if="q.correct.includes(o.key)" class="tag ok">correct</span>
              <span v-else-if="q.chosen.includes(o.key)" class="tag no">your answer</span>
            </li>
          </ul>
          <p v-if="q.explanation" class="explanation">{{ q.explanation }}</p>
        </li>
      </ol>
      <div class="actions">
        <ion-button
          v-if="quiz.canAttempt"
          :fill="quiz.passed ? 'outline' : 'solid'"
          data-testid="quiz-retake"
          @click="result = null"
          >{{ quiz.passed ? 'Take it again' : 'Try again' }}</ion-button
        >
        <p v-else-if="!quiz.passed" class="muted">You have used all {{ quiz.maxAttempts }} attempts.</p>
      </div>
    </template>

    <!-- Taking the quiz -->
    <template v-else>
      <p class="muted">
        {{ quiz.questions.length }} question{{ quiz.questions.length === 1 ? '' : 's' }} · pass mark
        {{ quiz.passPercent }}%
        <template v-if="quiz.maxAttempts">
          · attempt {{ Math.min(quiz.attemptsUsed + 1, quiz.maxAttempts) }} of
          {{ quiz.maxAttempts }}</template
        >
        <template v-if="quiz.passed"> · <ion-text color="success">passed</ion-text></template>
      </p>
      <template v-if="quiz.canAttempt">
        <ol class="questions">
          <li v-for="q in quiz.questions" :key="q.id" :data-testid="`quiz-q-${q.id}`">
            <p class="prompt">{{ q.prompt }}</p>
            <p class="muted small">{{ q.kind === 'multi' ? 'Choose all that apply' : 'Choose one' }}</p>
            <ion-radio-group
              v-if="q.kind === 'single'"
              :value="answers[q.id]?.[0]"
              @ion-change="answers[q.id] = [$event.detail.value as string]"
            >
              <ion-item v-for="o in q.options" :key="o.key" lines="none">
                <!-- md mode: an iOS radio draws nothing until it is checked, so the choices look inert. -->
                <ion-radio
                  mode="md"
                  :value="o.key"
                  justify="start"
                  label-placement="end"
                  :data-testid="`quiz-opt-${q.id}-${o.key}`"
                  >{{ o.key }}. {{ o.text }}</ion-radio
                >
              </ion-item>
            </ion-radio-group>
            <template v-else>
              <ion-item v-for="o in q.options" :key="o.key" lines="none">
                <ion-checkbox
                  justify="start"
                  label-placement="end"
                  :checked="answers[q.id]?.includes(o.key)"
                  :data-testid="`quiz-opt-${q.id}-${o.key}`"
                  @ion-change="toggle(q.id, o.key, $event.detail.checked)"
                  >{{ o.key }}. {{ o.text }}</ion-checkbox
                >
              </ion-item>
            </template>
          </li>
        </ol>
        <ion-button :disabled="busy || unanswered > 0" data-testid="quiz-submit" @click="submit">
          {{ unanswered ? `Answer all questions (${unanswered} left)` : 'Submit answers' }}
        </ion-button>
      </template>
      <p v-else class="muted">You have used all {{ quiz.maxAttempts }} attempts.</p>
    </template>

    <div v-if="quiz?.attempts.length" class="history">
      <h4>Your attempts</h4>
      <ion-list lines="inset">
        <ion-item v-for="a in quiz.attempts" :key="a.id" button :detail="false" @click="showAttempt(a.id)">
          <ion-label>{{ dateTime(a.createdAt) }}</ion-label>
          <ion-note slot="end" :color="a.passed ? 'success' : 'danger'">{{ a.percent }}%</ion-note>
        </ion-item>
      </ion-list>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import {
  IonButton,
  IonCheckbox,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonRadio,
  IonRadioGroup,
  IonSpinner,
  IonText,
} from '@ionic/vue';
import { checkmarkCircle, closeCircle } from 'ionicons/icons';
import type { MktQuizLearnerDto, MktQuizResultDto } from '@erp/shared';
import { toastError } from '@/core/toast';
import { quizApi } from '../quiz-api';

const props = defineProps<{ courseId: number; lectureId: number }>();
const emit = defineEmits<{ result: [MktQuizResultDto] }>();

const quiz = ref<MktQuizLearnerDto | null>(null);
const result = ref<MktQuizResultDto | null>(null);
const answers = reactive<Record<string, string[]>>({});
const busy = ref(false);

const unanswered = computed(() => quiz.value?.questions.filter((q) => !answers[q.id]?.length).length ?? 0);
const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });

function toggle(id: number, key: string, on: boolean) {
  const cur = answers[id] ?? [];
  answers[id] = on ? [...new Set([...cur, key])] : cur.filter((k) => k !== key);
}

async function load() {
  quiz.value = await quizApi.quiz(props.courseId, props.lectureId);
  for (const k of Object.keys(answers)) delete answers[k];
}

async function submit() {
  busy.value = true;
  try {
    const res = await quizApi.submit(props.courseId, props.lectureId, { answers: { ...answers } });
    await load();
    result.value = res;
    emit('result', res);
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

async function showAttempt(attemptId: number) {
  try {
    result.value = await quizApi.attempt(props.courseId, props.lectureId, attemptId);
  } catch (e) {
    void toastError(e);
  }
}

onMounted(() => load().catch(toastError));
</script>

<style scoped>
.quiz {
  max-width: 760px;
  padding: 8px 4px 16px;
}
.questions {
  padding-left: 20px;
}
.questions > li {
  margin-bottom: 18px;
}
.prompt {
  font-weight: 600;
  margin: 0 0 4px;
  white-space: pre-wrap;
}
.prompt ion-icon {
  vertical-align: -3px;
}
.options {
  list-style: none;
  padding: 0;
  margin: 6px 0;
}
.options li {
  padding: 6px 10px;
  border-radius: 6px;
  margin-bottom: 4px;
  background: var(--ion-color-light);
}
.options li.correct {
  background: rgba(var(--ion-color-success-rgb), 0.15);
}
.options li.chosen:not(.correct) {
  background: rgba(var(--ion-color-danger-rgb), 0.12);
}
.tag {
  font-size: 11px;
  margin-left: 6px;
  font-weight: 600;
}
.tag.ok {
  color: var(--ion-color-success-shade);
}
.tag.no {
  color: var(--ion-color-danger);
}
.explanation {
  font-size: 14px;
  color: var(--ion-color-medium-shade);
  border-left: 3px solid var(--ion-color-primary);
  padding-left: 8px;
}
.banner {
  border-radius: 8px;
  padding: 12px 16px;
  margin-bottom: 16px;
}
.banner h3 {
  margin: 0 0 4px;
}
.banner p {
  margin: 0;
}
.banner.pass {
  background: rgba(var(--ion-color-success-rgb), 0.15);
}
.banner.fail {
  background: rgba(var(--ion-color-warning-rgb), 0.18);
}
.history h4 {
  margin: 16px 0 4px;
}
.muted {
  color: var(--ion-color-medium);
}
.small {
  font-size: 12px;
  margin: 0 0 4px;
}
.center {
  text-align: center;
  padding: 40px;
}
</style>
