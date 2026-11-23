<template>
  <AppPage
    :title="isEdit ? t('exams.form.editTitle') : t('exams.form.newTitle')"
    :back-href="isEdit ? `/exams/${id}` : '/exams'"
  >
    <!-- New test: three short steps. Editing: everything on one page. -->
    <p v-if="!isEdit" class="steps" aria-live="polite">
      {{ t('exams.form.stepOf', { n: step, total: 3 }) }} · {{ t(`exams.form.step${step}`) }}
    </p>

    <FormSection v-show="isEdit || step === 1" :title="isEdit ? t('exams.form.step1') : undefined">
      <ion-item>
        <ion-input
          v-model="form.title"
          :label="t('exams.form.name')"
          label-placement="stacked"
          :placeholder="t('exams.form.namePlaceholder')"
          :maxlength="200"
        />
      </ion-item>
      <template v-if="target === 'batch'">
        <p class="field-label">{{ t('exams.form.batch') }}</p>
        <div class="chips" role="radiogroup" :aria-label="t('exams.form.batch')">
          <button
            v-for="b in batches"
            :key="b.id"
            type="button"
            role="radio"
            :aria-checked="form.batchId === b.id"
            :class="['chip', { on: form.batchId === b.id }]"
            :disabled="locked"
            @click="form.batchId = b.id"
          >
            {{ b.name }}
          </button>
        </div>
      </template>
      <ion-item v-else>
        <ion-select
          v-model="form.courseId"
          :label="t('exams.form.course')"
          interface="popover"
          :disabled="locked"
        >
          <ion-select-option v-for="c in courses" :key="c.id" :value="c.id">{{ c.name }}</ion-select-option>
        </ion-select>
      </ion-item>
      <p class="field-label">{{ t('exams.form.subject') }}</p>
      <div class="chips" role="radiogroup" :aria-label="t('exams.form.subject')">
        <button
          type="button"
          role="radio"
          :aria-checked="form.subjectId === null"
          :class="['chip', { on: form.subjectId === null }]"
          @click="form.subjectId = null"
        >
          {{ t('exams.form.allSubjects') }}
        </button>
        <button
          v-for="s in subjects"
          :key="s.id"
          type="button"
          role="radio"
          :aria-checked="form.subjectId === s.id"
          :class="['chip', { on: form.subjectId === s.id }]"
          @click="form.subjectId = s.id"
        >
          {{ s.name }}
        </button>
      </div>
    </FormSection>

    <FormSection v-show="isEdit || step === 2" :title="isEdit ? t('exams.form.step2') : undefined">
      <div class="patterns" role="radiogroup" :aria-label="t('exams.form.step2')">
        <button
          v-for="p in patternChoices"
          :key="p.id"
          type="button"
          role="radio"
          :aria-checked="pattern === p.id"
          :class="['pattern', { on: pattern === p.id }]"
          :disabled="locked"
          @click="choosePattern(p.id)"
        >
          <strong>{{ t(`exams.form.patterns.${p.id}`) }}</strong>
          <span v-if="p.id !== 'custom'">{{
            t('exams.form.patternHint', {
              marks: p.defaultMarks,
              negative: p.defaultNegativeMarks,
              duration: formatDuration(p.durationMinutes * 60),
            })
          }}</span>
          <span v-else>{{ t('exams.form.patternCustomHint') }}</span>
        </button>
      </div>
      <template v-if="pattern === 'custom'">
        <ion-item>
          <ion-input
            v-model.number="form.defaultMarks"
            type="number"
            :label="t('exams.form.marks')"
            label-placement="stacked"
            :disabled="locked"
          />
        </ion-item>
        <ion-item>
          <ion-input
            v-model.number="form.defaultNegativeMarks"
            type="number"
            :label="t('exams.form.negative')"
            label-placement="stacked"
            :disabled="locked"
          />
        </ion-item>
        <ion-item>
          <ion-input
            v-model.number="form.durationMinutes"
            type="number"
            :label="t('exams.form.duration')"
            label-placement="stacked"
            :min="1"
            :disabled="locked"
          />
        </ion-item>
        <ion-item>
          <ion-toggle v-model="form.partialMarking" :disabled="locked">{{
            t('exams.form.partial')
          }}</ion-toggle>
        </ion-item>
      </template>
    </FormSection>

    <FormSection v-show="isEdit || step === 3" :title="isEdit ? t('exams.form.step3') : undefined">
      <ion-item>
        <ion-input
          v-model="startAt"
          type="datetime-local"
          :label="t('exams.form.opens')"
          label-placement="stacked"
          :disabled="locked"
        />
      </ion-item>
      <p class="summary">
        {{
          t('exams.form.closesSummary', {
            duration: formatDuration((form.durationMinutes || 0) * 60),
            closes: formatDateTime(effectiveEnd),
          })
        }}
      </p>
    </FormSection>

    <FormSection v-show="isEdit || step === 3" v-model:open="moreOpen" advanced>
      <ion-item>
        <ion-toggle v-model="lateStart" :disabled="locked">{{ t('exams.form.lateStart') }}</ion-toggle>
      </ion-item>
      <ion-item v-if="lateStart">
        <ion-input
          v-model="endAt"
          type="datetime-local"
          :label="t('exams.form.closes')"
          label-placement="stacked"
        />
      </ion-item>
      <ion-item>
        <ion-textarea
          v-model="form.instructions"
          :label="t('exams.form.instructions')"
          label-placement="stacked"
          auto-grow
        />
      </ion-item>
      <ion-item>
        <ion-textarea
          v-model="form.description"
          :label="t('exams.form.description')"
          label-placement="stacked"
          auto-grow
        />
      </ion-item>
      <ion-item>
        <ion-input
          v-model.number="passMarks"
          type="number"
          :label="t('exams.form.passMarks')"
          label-placement="stacked"
        />
      </ion-item>
      <ion-item>
        <ion-toggle v-model="form.shuffleQuestions" :disabled="locked">{{
          t('exams.form.shuffleQuestions')
        }}</ion-toggle>
      </ion-item>
      <ion-item>
        <ion-toggle v-model="form.shuffleOptions" :disabled="locked">{{
          t('exams.form.shuffleOptions')
        }}</ion-toggle>
      </ion-item>
      <ion-item>
        <ion-toggle
          :checked="target === 'course'"
          :disabled="locked"
          @ion-change="toggleCourse($event.detail.checked)"
        >
          {{ t('exams.form.wholeCourse') }}
        </ion-toggle>
      </ion-item>
      <ion-item>
        <ion-select v-model="form.evaluationMode" :label="t('exams.form.evaluation')" interface="popover">
          <ion-select-option
            v-for="m in EVALUATION_MODES"
            :key="m"
            :value="m"
            :disabled="m === 'ai_only' && !auth.can('exams.configure')"
          >
            {{ EVALUATION_MODE_LABELS[m] }}
          </ion-select-option>
        </ion-select>
      </ion-item>
      <ion-item v-if="form.evaluationMode !== 'manual' && prompts.length">
        <ion-select v-model="form.promptVersionId" :label="t('exams.form.prompt')" interface="popover">
          <ion-select-option :value="null">{{ t('exams.form.activePrompt') }}</ion-select-option>
          <ion-select-option v-for="p in prompts" :key="p.id" :value="p.id"
            >v{{ p.version }} · {{ p.name }}</ion-select-option
          >
        </ion-select>
      </ion-item>
      <ion-note v-if="form.evaluationMode === 'ai_only'" class="hint">{{
        t('exams.form.aiOnlyHint')
      }}</ion-note>
    </FormSection>

    <ion-note v-if="locked" class="hint">{{ t('exams.form.lockedHint') }}</ion-note>
    <p v-if="problem && (isEdit || step === 3)" class="problem" role="alert">{{ problem }}</p>

    <div class="actions">
      <ion-button v-if="!isEdit && step > 1" fill="outline" size="large" @click="step--">{{
        t('exams.form.back')
      }}</ion-button>
      <ion-button v-if="!isEdit && step < 3" size="large" :disabled="!!stepProblem" @click="step++">{{
        t('exams.form.next')
      }}</ion-button>
      <ion-button v-else size="large" :disabled="saving || !!problem" @click="save">{{
        isEdit ? t('exams.form.saveChanges') : t('exams.form.create')
      }}</ion-button>
    </div>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  IonButton,
  IonInput,
  IonItem,
  IonNote,
  IonSelect,
  IonSelectOption,
  IonTextarea,
  IonToggle,
  onIonViewWillEnter,
} from '@ionic/vue';
import {
  EVALUATION_MODES,
  EVALUATION_MODE_LABELS,
  type BatchDto,
  type CourseDto,
  type ExamInput,
  type PromptVersionDto,
  type SubjectDto,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import FormSection from '@/components/FormSection.vue';
import { formatDateTime, formatDuration } from '@/core/format';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { academicsApi } from '@/modules/academics/api';
import { examsApi } from './api';
import {
  closesAfter,
  defaultOpens,
  EXAM_PATTERNS,
  patternOf,
  toLocalInput,
  type ExamPattern,
} from './presets';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const id = computed(() => Number(route.params.id) || 0);
const isEdit = computed(() => id.value > 0);

const form = reactive<ExamInput>({
  title: '',
  description: '',
  instructions: '',
  batchId: null,
  courseId: null,
  subjectId: null,
  startAt: '',
  endAt: '',
  durationMinutes: 60,
  evaluationMode: 'manual',
  promptVersionId: null,
  shuffleQuestions: false,
  shuffleOptions: false,
  partialMarking: false,
  defaultMarks: 1,
  defaultNegativeMarks: 0,
});
const step = ref(1);
const pattern = ref<ExamPattern['id']>('simple');
const passMarks = ref<number | null>(null);
const target = ref<'batch' | 'course'>('batch');
const startAt = ref(toLocalInput(defaultOpens()));
/** Off: a fixed-time test that closes when its duration ends. On: candidates may start until `endAt`. */
const lateStart = ref(false);
const endAt = ref(closesAfter(startAt.value, 60));
const moreOpen = ref(false);
const locked = ref(false);
const saving = ref(false);
const batches = ref<BatchDto[]>([]);
const courses = ref<CourseDto[]>([]);
const subjects = ref<SubjectDto[]>([]);
const prompts = ref<PromptVersionDto[]>([]);

const patternChoices: readonly ExamPattern[] = [
  ...EXAM_PATTERNS,
  { id: 'custom', defaultMarks: 0, defaultNegativeMarks: 0, durationMinutes: 0, partialMarking: false },
];
const effectiveEnd = computed(() =>
  lateStart.value ? endAt.value : closesAfter(startAt.value, form.durationMinutes),
);

const stepProblem = computed(() => {
  if (step.value === 1 || isEdit.value) {
    if (!form.title.trim()) return t('exams.form.needName');
    if (target.value === 'batch' ? !form.batchId : !form.courseId) return t('exams.form.needBatch');
  }
  if (step.value === 2 || isEdit.value) {
    if (!(form.durationMinutes > 0)) return t('exams.form.needDuration');
  }
  return '';
});
const problem = computed(() => {
  if (stepProblem.value) return stepProblem.value;
  if (!startAt.value) return t('exams.form.needOpens');
  if (new Date(effectiveEnd.value) <= new Date(startAt.value)) return t('exams.form.needCloseAfter');
  return '';
});

function choosePattern(p: ExamPattern['id']) {
  pattern.value = p;
  const preset = EXAM_PATTERNS.find((x) => x.id === p);
  if (preset)
    Object.assign(form, {
      defaultMarks: preset.defaultMarks,
      defaultNegativeMarks: preset.defaultNegativeMarks,
      durationMinutes: preset.durationMinutes,
      partialMarking: preset.partialMarking,
    });
}

function toggleCourse(on: boolean) {
  target.value = on ? 'course' : 'batch';
}

// Keep a late-start close time sensible when it is first turned on.
watch(lateStart, (on) => {
  if (on && new Date(endAt.value) <= new Date(startAt.value))
    endAt.value = closesAfter(startAt.value, form.durationMinutes + 60);
});

async function loadLookups() {
  const [b, c, s] = await Promise.allSettled([
    academicsApi.batches({ status: 'active' }),
    academicsApi.courses(),
    academicsApi.subjects(),
  ]);
  if (b.status === 'fulfilled') batches.value = b.value.items;
  if (c.status === 'fulfilled') courses.value = c.value.items;
  if (s.status === 'fulfilled') subjects.value = s.value;
  if (!isEdit.value && batches.value.length === 1 && !form.batchId) form.batchId = batches.value[0].id;
  if (auth.can('exams.configure'))
    prompts.value = (await examsApi.promptVersions().catch(() => ({ versions: [] }))).versions;
}

onIonViewWillEnter(async () => {
  await loadLookups();
  if (!isEdit.value) return;
  try {
    const e = await examsApi.get(id.value);
    Object.assign(form, {
      title: e.title,
      description: e.description ?? '',
      instructions: e.instructions ?? '',
      batchId: e.batchId,
      courseId: e.courseId,
      subjectId: e.subjectId,
      durationMinutes: e.durationMinutes,
      evaluationMode: e.evaluationMode,
      promptVersionId: e.promptVersionId,
      shuffleQuestions: e.shuffleQuestions,
      shuffleOptions: e.shuffleOptions,
      partialMarking: e.partialMarking,
      defaultMarks: e.defaultMarks,
      defaultNegativeMarks: e.defaultNegativeMarks,
    });
    pattern.value = patternOf(e);
    passMarks.value = e.passMarks;
    target.value = e.batchId ? 'batch' : 'course';
    startAt.value = toLocalInput(new Date(e.startAt));
    endAt.value = toLocalInput(new Date(e.endAt));
    lateStart.value = endAt.value !== closesAfter(startAt.value, e.durationMinutes);
    moreOpen.value = true;
    locked.value = e.phase !== 'draft' && e.phase !== 'upcoming';
  } catch (err) {
    await toastError(err);
  }
});

async function save() {
  saving.value = true;
  try {
    const body: ExamInput = {
      ...form,
      title: form.title.trim(),
      batchId: target.value === 'batch' ? form.batchId : null,
      courseId: target.value === 'course' ? form.courseId : null,
      description: form.description || null,
      instructions: form.instructions || null,
      passMarks: typeof passMarks.value === 'number' ? passMarks.value : null,
      startAt: new Date(startAt.value).toISOString(),
      endAt: new Date(effectiveEnd.value).toISOString(),
    };
    if (locked.value) {
      const {
        title,
        description,
        instructions,
        endAt: end,
        evaluationMode,
        promptVersionId,
        subjectId,
      } = body;
      await examsApi.update(id.value, {
        title,
        description,
        instructions,
        endAt: end,
        evaluationMode,
        promptVersionId,
        passMarks: body.passMarks,
        subjectId,
      });
      await toast(t('exams.form.updated'));
      router.replace(`/exams/${id.value}`);
    } else if (isEdit.value) {
      await examsApi.update(id.value, body);
      await toast(t('exams.form.updated'));
      router.replace(`/exams/${id.value}`);
    } else {
      const created = await examsApi.create(body);
      await toast(t('exams.form.created'));
      router.replace(`/exams/${created.id}`);
    }
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.steps {
  margin: 0 0 8px;
  color: var(--ion-color-medium-shade);
  font-weight: 600;
}
.field-label {
  margin: 16px 16px 8px;
  color: var(--ion-color-medium-shade);
  font-size: 14px;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 0 16px 8px;
}
.chip {
  min-height: var(--app-tap-target);
  padding: 0 16px;
  border: 1px solid var(--ion-color-medium-tint);
  border-radius: 24px;
  background: none;
  color: var(--ion-text-color);
  font: inherit;
  cursor: pointer;
}
.chip.on,
.pattern.on {
  border-color: var(--ion-color-primary);
  background: rgba(var(--ion-color-primary-rgb), 0.12);
  color: var(--ion-color-primary-shade);
  font-weight: 600;
}
.patterns {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 10px;
  padding: 4px 0 8px;
}
.pattern {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  min-height: 76px;
  padding: 12px 14px;
  border: 1px solid var(--ion-color-medium-tint);
  border-radius: 14px;
  background: none;
  color: var(--ion-text-color);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.pattern span {
  color: var(--ion-color-medium-shade);
  font-size: 13px;
  font-weight: 400;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
.summary {
  margin: 8px 16px;
  color: var(--ion-color-medium-shade);
}
.hint {
  display: block;
  padding: 8px 16px;
}
.problem {
  margin: 8px 16px 0;
  color: var(--ion-color-danger);
}
.actions {
  display: flex;
  gap: 10px;
  margin-top: 16px;
}
.actions ion-button {
  flex: 1;
  text-transform: none;
}
</style>
