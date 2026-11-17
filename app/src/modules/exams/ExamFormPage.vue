<template>
  <AppPage :title="isEdit ? 'Edit exam' : 'New exam'" :back-href="isEdit ? `/exams/${id}` : '/exams'">
    <ion-list>
      <ion-item>
        <ion-input v-model="form.title" label="Title" label-placement="stacked" :maxlength="200" />
      </ion-item>
      <ion-item>
        <ion-textarea v-model="form.description" label="Description" label-placement="stacked" auto-grow />
      </ion-item>
      <ion-item>
        <ion-textarea
          v-model="form.instructions"
          label="Instructions for candidates"
          label-placement="stacked"
          auto-grow
        />
      </ion-item>

      <ion-list-header><ion-label>Who takes it</ion-label></ion-list-header>
      <ion-item>
        <ion-select v-model="target" label="Assign to" interface="popover" :disabled="locked">
          <ion-select-option value="batch">A batch</ion-select-option>
          <ion-select-option value="course">All batches of a course</ion-select-option>
        </ion-select>
      </ion-item>
      <ion-item v-if="target === 'batch'">
        <ion-select v-model="form.batchId" label="Batch" interface="popover" :disabled="locked">
          <ion-select-option v-for="b in batches" :key="b.id" :value="b.id"
            >{{ b.name }} ({{ b.code }})</ion-select-option
          >
        </ion-select>
      </ion-item>
      <ion-item v-else>
        <ion-select v-model="form.courseId" label="Course" interface="popover" :disabled="locked">
          <ion-select-option v-for="c in courses" :key="c.id" :value="c.id">{{ c.name }}</ion-select-option>
        </ion-select>
      </ion-item>
      <ion-item>
        <ion-select v-model="form.subjectId" label="Subject (optional)" interface="popover">
          <ion-select-option :value="null">—</ion-select-option>
          <ion-select-option v-for="s in subjects" :key="s.id" :value="s.id">{{ s.name }}</ion-select-option>
        </ion-select>
      </ion-item>

      <ion-list-header><ion-label>Window</ion-label></ion-list-header>
      <ion-item>
        <ion-input
          v-model="startAt"
          type="datetime-local"
          label="Opens"
          label-placement="stacked"
          :disabled="locked"
        />
      </ion-item>
      <ion-item>
        <ion-input v-model="endAt" type="datetime-local" label="Closes" label-placement="stacked" />
      </ion-item>
      <ion-item>
        <ion-input
          v-model.number="form.durationMinutes"
          type="number"
          label="Duration (minutes)"
          label-placement="stacked"
          :min="1"
          :disabled="locked"
        />
      </ion-item>

      <ion-list-header><ion-label>Marking scheme</ion-label></ion-list-header>
      <ion-item>
        <ion-input
          v-model.number="form.defaultMarks"
          type="number"
          label="Marks per question"
          label-placement="stacked"
          :disabled="locked"
        />
      </ion-item>
      <ion-item>
        <ion-input
          v-model.number="form.defaultNegativeMarks"
          type="number"
          label="Negative marks per wrong answer"
          label-placement="stacked"
          :disabled="locked"
        />
      </ion-item>
      <ion-item>
        <ion-toggle v-model="form.partialMarking" :disabled="locked"
          >Partial marks for multi-correct MCQs</ion-toggle
        >
      </ion-item>
      <ion-item>
        <ion-input
          v-model.number="passMarks"
          type="number"
          label="Pass marks (optional)"
          label-placement="stacked"
        />
      </ion-item>
      <ion-item>
        <ion-toggle v-model="form.shuffleQuestions" :disabled="locked">Shuffle questions</ion-toggle>
      </ion-item>
      <ion-item>
        <ion-toggle v-model="form.shuffleOptions" :disabled="locked">Shuffle options</ion-toggle>
      </ion-item>

      <ion-list-header><ion-label>Evaluation of descriptive answers</ion-label></ion-list-header>
      <ion-item>
        <ion-select v-model="form.evaluationMode" label="Mode" interface="popover">
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
        <ion-select v-model="form.promptVersionId" label="Grading prompt" interface="popover">
          <ion-select-option :value="null">Active institute prompt</ion-select-option>
          <ion-select-option v-for="p in prompts" :key="p.id" :value="p.id"
            >v{{ p.version }} · {{ p.name }}</ion-select-option
          >
        </ion-select>
      </ion-item>
      <ion-note v-if="form.evaluationMode === 'ai_only'" class="hint">
        AI-only marks are final without teacher review. AI usage counts against the plan's AI quota.
      </ion-note>
    </ion-list>
    <ion-note v-if="locked" class="hint"
      >Candidates have started: the audience, timing and marking scheme are locked.</ion-note
    >
    <ion-button expand="block" :disabled="saving" @click="save">{{
      isEdit ? 'Save changes' : 'Create exam'
    }}</ion-button>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  IonButton,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
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
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { academicsApi } from '@/modules/academics/api';
import { examsApi } from './api';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const id = computed(() => Number(route.params.id) || 0);
const isEdit = computed(() => id.value > 0);

const toLocal = (d: Date) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

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
const passMarks = ref<number | null>(null);
const target = ref<'batch' | 'course'>('batch');
const startAt = ref(toLocal(new Date(Date.now() + 86_400_000)));
const endAt = ref(toLocal(new Date(Date.now() + 86_400_000 + 3 * 3600_000)));
const locked = ref(false);
const saving = ref(false);
const batches = ref<BatchDto[]>([]);
const courses = ref<CourseDto[]>([]);
const subjects = ref<SubjectDto[]>([]);
const prompts = ref<PromptVersionDto[]>([]);

async function loadLookups() {
  const [b, c, s] = await Promise.allSettled([
    academicsApi.batches({ status: 'active' }),
    academicsApi.courses(),
    academicsApi.subjects(),
  ]);
  if (b.status === 'fulfilled') batches.value = b.value.items;
  if (c.status === 'fulfilled') courses.value = c.value.items;
  if (s.status === 'fulfilled') subjects.value = s.value;
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
    passMarks.value = e.passMarks;
    target.value = e.batchId ? 'batch' : 'course';
    startAt.value = toLocal(new Date(e.startAt));
    endAt.value = toLocal(new Date(e.endAt));
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
      batchId: target.value === 'batch' ? form.batchId : null,
      courseId: target.value === 'course' ? form.courseId : null,
      description: form.description || null,
      instructions: form.instructions || null,
      passMarks: typeof passMarks.value === 'number' ? passMarks.value : null,
      startAt: new Date(startAt.value).toISOString(),
      endAt: new Date(endAt.value).toISOString(),
    };
    if (locked.value) {
      const {
        title,
        description,
        instructions,
        endAt: end,
        evaluationMode,
        promptVersionId,
        passMarks: pm,
        subjectId,
      } = body;
      await examsApi.update(id.value, {
        title,
        description,
        instructions,
        endAt: end,
        evaluationMode,
        promptVersionId,
        passMarks: pm,
        subjectId,
      });
      await toast('Exam updated');
      router.replace(`/exams/${id.value}`);
    } else if (isEdit.value) {
      await examsApi.update(id.value, body);
      await toast('Exam updated');
      router.replace(`/exams/${id.value}`);
    } else {
      const created = await examsApi.create(body);
      await toast('Exam created — now add questions');
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
.hint {
  display: block;
  padding: 8px 16px;
}
</style>
