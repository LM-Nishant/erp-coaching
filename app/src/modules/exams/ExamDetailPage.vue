<template>
  <AppPage :title="exam?.title ?? 'Exam'" back-href="/exams" :on-refresh="load">
    <template v-if="exam">
      <ion-card>
        <ion-card-header>
          <ion-card-subtitle>
            <ion-badge :color="PHASE_COLORS[exam.phase]">{{ exam.phase }}</ion-badge>
            {{ EVALUATION_MODE_LABELS[exam.evaluationMode] }}
          </ion-card-subtitle>
          <ion-card-title>{{ exam.title }}</ion-card-title>
        </ion-card-header>
        <ion-card-content>
          <p>{{ exam.batchName ?? exam.courseName ?? 'All students' }}</p>
          <p>
            {{ formatDate(exam.startAt) }} → {{ formatDate(exam.endAt) }} · {{ exam.durationMinutes }} min
          </p>
          <p>
            {{ exam.questionCount }} questions · {{ fmtMarks(exam.totalMarks) }} marks · +{{
              fmtMarks(exam.defaultMarks)
            }}
            / −{{ fmtMarks(exam.defaultNegativeMarks) }}
            <span v-if="exam.partialMarking">· partial marking</span>
            <span v-if="exam.passMarks !== null">· pass {{ fmtMarks(exam.passMarks) }}</span>
          </p>
          <p v-if="exam.shuffleQuestions || exam.shuffleOptions" class="muted">
            Shuffled
            {{
              [exam.shuffleQuestions && 'questions', exam.shuffleOptions && 'options']
                .filter(Boolean)
                .join(' & ')
            }}
          </p>
        </ion-card-content>
        <div class="actions">
          <ion-button
            v-if="editable"
            v-can="'exams.edit'"
            size="small"
            fill="outline"
            :router-link="`/exams/${exam.id}/edit`"
          >
            Edit
          </ion-button>
          <ion-button
            v-if="exam.status === 'draft'"
            v-can="'exams.edit'"
            size="small"
            @click="act('schedule')"
          >
            Schedule
          </ion-button>
          <ion-button
            v-if="['closed', 'live', 'published'].includes(exam.phase)"
            v-can="'exams.approve'"
            size="small"
            fill="outline"
            :router-link="`/exams/${exam.id}/evaluate`"
          >
            Evaluate
          </ion-button>
          <ion-button
            v-if="exam.status === 'scheduled'"
            size="small"
            fill="outline"
            :router-link="`/exams/${exam.id}/results`"
          >
            Results &amp; analytics
          </ion-button>
          <ion-button v-can="'exams.create'" size="small" fill="clear" @click="act('duplicate')"
            >Duplicate</ion-button
          >
          <ion-button
            v-if="exam.status === 'scheduled' && !exam.resultsPublishedAt"
            v-can="'exams.edit'"
            size="small"
            fill="clear"
            color="warning"
            @click="act('cancel')"
          >
            Cancel exam
          </ion-button>
          <ion-button
            v-if="exam.status !== 'scheduled'"
            v-can="'exams.delete'"
            size="small"
            fill="clear"
            color="danger"
            @click="act('delete')"
          >
            Delete
          </ion-button>
        </div>
      </ion-card>

      <SecureView screen="question-paper">
        <ion-list v-for="s in exam.sections" :key="s.id">
          <ion-list-header>
            <ion-label>
              <h2>{{ s.title }}</h2>
              <p v-if="s.instructions">{{ s.instructions }}</p>
            </ion-label>
            <template v-if="editable && canEdit">
              <ion-button size="small" @click="openPicker(s.id)"
                ><ion-icon slot="start" :icon="add" />Questions</ion-button
              >
              <ion-button size="small" fill="clear" @click="renameSection(s)"
                ><ion-icon slot="icon-only" :icon="createOutline"
              /></ion-button>
              <ion-button
                v-if="exam.sections.length > 1"
                size="small"
                fill="clear"
                color="danger"
                @click="removeSection(s.id)"
              >
                <ion-icon slot="icon-only" :icon="trashOutline" />
              </ion-button>
            </template>
          </ion-list-header>
          <ion-item v-for="(eq, i) in questionsOf(s.id)" :key="eq.id">
            <ion-label class="ion-text-wrap">
              <h3>Q{{ i + 1 }}. {{ eq.question.text }}</h3>
              <p>
                {{ QUESTION_TYPE_LABELS[eq.question.type] }} · {{ eq.question.difficulty }} · +{{
                  fmtMarks(eq.marks)
                }}
                <span v-if="eq.negativeMarks">/ −{{ fmtMarks(eq.negativeMarks) }}</span>
                <span v-if="eq.question.chapterName"> · {{ eq.question.chapterName }}</span>
              </p>
            </ion-label>
            <template v-if="editable && canEdit">
              <ion-button slot="end" fill="clear" size="small" @click="editMarks(eq)">Marks</ion-button>
              <ion-button
                slot="end"
                fill="clear"
                size="small"
                title="Re-copy the latest version from the bank"
                @click="refresh(eq.id)"
              >
                <ion-icon slot="icon-only" :icon="refreshOutline" />
              </ion-button>
              <ion-button slot="end" fill="clear" size="small" color="danger" @click="removeQuestion(eq.id)">
                <ion-icon slot="icon-only" :icon="closeOutline" />
              </ion-button>
            </template>
          </ion-item>
          <ion-item v-if="!questionsOf(s.id).length"
            ><ion-label class="muted">No questions in this section.</ion-label></ion-item
          >
        </ion-list>
      </SecureView>
      <ion-button v-if="editable && canEdit" fill="outline" expand="block" @click="addSection"
        >Add section</ion-button
      >
    </template>

    <ion-modal :is-open="picker.open" @did-dismiss="picker.open = false">
      <ion-header>
        <ion-toolbar>
          <ion-title>Add questions</ion-title>
          <ion-buttons slot="end"><ion-button @click="picker.open = false">Close</ion-button></ion-buttons>
        </ion-toolbar>
        <ion-toolbar>
          <ion-searchbar v-model="picker.q" :debounce="400" placeholder="Search question text" />
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <ion-item>
          <ion-select v-model="picker.bankId" label="Bank" interface="popover">
            <ion-select-option :value="null">All accessible banks</ion-select-option>
            <ion-select-option v-for="b in banks" :key="b.id" :value="b.id">{{ b.name }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item>
          <ion-select v-model="picker.type" label="Type" interface="popover">
            <ion-select-option value="">Any</ion-select-option>
            <ion-select-option v-for="t in QUESTION_TYPES" :key="t" :value="t">{{
              QUESTION_TYPE_LABELS[t]
            }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item>
          <ion-select v-model="picker.difficulty" label="Difficulty" interface="popover">
            <ion-select-option value="">Any</ion-select-option>
            <ion-select-option v-for="d in QUESTION_DIFFICULTIES" :key="d" :value="d">{{
              d
            }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-list>
          <ion-item v-for="q in picker.items" :key="q.id">
            <ion-checkbox
              slot="start"
              :checked="picker.selected.has(q.id)"
              :disabled="inExam.has(q.id)"
              @ion-change="toggle(q.id, $event.detail.checked)"
            />
            <ion-label class="ion-text-wrap">
              <h3>{{ q.text }}</h3>
              <p>
                {{ QUESTION_TYPE_LABELS[q.type] }} · {{ q.difficulty }}
                <span v-if="q.chapterName"> · {{ q.chapterName }}</span>
                <span v-if="inExam.has(q.id)"> · already added</span>
              </p>
            </ion-label>
          </ion-item>
          <ion-item v-if="!picker.items.length"
            ><ion-label class="muted">No matching active questions.</ion-label></ion-item
          >
        </ion-list>
        <ion-item>
          <ion-input
            v-model.number="picker.marks"
            type="number"
            label="Marks (blank = exam default)"
            label-placement="stacked"
          />
        </ion-item>
        <ion-item>
          <ion-input
            v-model.number="picker.negativeMarks"
            type="number"
            label="Negative marks (blank = exam default)"
            label-placement="stacked"
          />
        </ion-item>
        <ion-button expand="block" :disabled="!picker.selected.size" @click="addSelected">
          Add {{ picker.selected.size }} question(s)
        </ion-button>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardSubtitle,
  IonCardTitle,
  IonCheckbox,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonModal,
  IonSearchbar,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToolbar,
  alertController,
  onIonViewWillEnter,
} from '@ionic/vue';
import { add, closeOutline, createOutline, refreshOutline, trashOutline } from 'ionicons/icons';
import {
  EVALUATION_MODE_LABELS,
  QUESTION_DIFFICULTIES,
  QUESTION_TYPES,
  QUESTION_TYPE_LABELS,
  type ExamDetailDto,
  type ExamQuestionDto,
  type ExamSectionDto,
  type QuestionBankDto,
  type QuestionDto,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import SecureView from '@/components/SecureView.vue';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { questionBankApi } from '@/modules/question-bank/api';
import { PHASE_COLORS, examsApi, fmtMarks, formatDate } from './api';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const id = computed(() => Number(route.params.id));
const exam = ref<ExamDetailDto | null>(null);
const banks = ref<QuestionBankDto[]>([]);
const canEdit = computed(() => auth.can('exams.edit'));
const editable = computed(
  () => !!exam.value && (exam.value.phase === 'draft' || exam.value.phase === 'upcoming'),
);
const inExam = computed(() => new Set(exam.value?.questions.map((q) => q.questionId) ?? []));

const picker = reactive({
  open: false,
  sectionId: 0,
  bankId: null as number | null,
  type: '',
  difficulty: '',
  q: '',
  items: [] as QuestionDto[],
  selected: new Set<number>(),
  marks: null as number | null,
  negativeMarks: null as number | null,
});

const questionsOf = (sectionId: number) =>
  (exam.value?.questions ?? [])
    .filter((q) => q.sectionId === sectionId)
    .sort((a, b) => a.sortOrder - b.sortOrder);

async function load() {
  try {
    exam.value = await examsApi.get(id.value);
  } catch (e) {
    await toastError(e);
  }
}
onIonViewWillEnter(load);

async function run<T>(fn: () => Promise<T>, msg?: string) {
  try {
    const r = await fn();
    if (msg) await toast(msg);
    return r;
  } catch (e) {
    await toastError(e);
    return undefined;
  }
}

async function confirm(
  header: string,
  message: string,
  withReason = false,
): Promise<{ ok: boolean; reason?: string }> {
  const a = await alertController.create({
    header,
    message,
    inputs: withReason ? [{ name: 'reason', placeholder: 'Reason (shared with candidates)' }] : [],
    buttons: [
      { text: 'Back', role: 'cancel' },
      { text: 'Confirm', role: 'confirm' },
    ],
  });
  await a.present();
  const { role, data } = await a.onDidDismiss<{ values: { reason?: string } }>();
  return { ok: role === 'confirm', reason: data?.values?.reason };
}

async function act(action: 'schedule' | 'cancel' | 'duplicate' | 'delete') {
  const e = exam.value!;
  if (action === 'schedule') {
    const c = await confirm(
      'Schedule exam?',
      'Candidates are notified and the exam opens at its start time.',
    );
    if (!c.ok) return;
    const r = await run(() => examsApi.schedule(e.id), 'Exam scheduled');
    if (r) exam.value = r;
  } else if (action === 'cancel') {
    const c = await confirm('Cancel exam?', 'In-progress attempts are closed.', true);
    if (!c.ok) return;
    const r = await run(() => examsApi.cancel(e.id, c.reason || undefined), 'Exam cancelled');
    if (r) exam.value = r;
  } else if (action === 'duplicate') {
    const r = await run(() => examsApi.duplicate(e.id), 'Copy created as a draft');
    if (r) router.push(`/exams/${r.id}`);
  } else {
    const c = await confirm('Delete exam?', 'This cannot be undone.');
    if (!c.ok) return;
    const ok = await run(() => examsApi.remove(e.id).then(() => true), 'Exam deleted');
    if (ok) router.replace('/exams');
  }
}

async function prompt(
  header: string,
  inputs: { name: string; value?: string | number; type?: 'text' | 'number'; placeholder?: string }[],
) {
  const a = await alertController.create({
    header,
    inputs: inputs.map((i) => ({ ...i, type: i.type ?? 'text' })),
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: 'Save', role: 'confirm' },
    ],
  });
  await a.present();
  const { role, data } = await a.onDidDismiss<{ values: Record<string, string> }>();
  return role === 'confirm' ? data!.values : null;
}

async function addSection() {
  const v = await prompt('New section', [
    { name: 'title', placeholder: 'Title' },
    { name: 'instructions', placeholder: 'Instructions (optional)' },
  ]);
  if (!v?.title) return;
  await run(
    () => examsApi.addSection(id.value, { title: v.title, instructions: v.instructions || null }),
    'Section added',
  );
  await load();
}

async function renameSection(s: ExamSectionDto) {
  const v = await prompt('Edit section', [
    { name: 'title', value: s.title },
    { name: 'instructions', value: s.instructions ?? '', placeholder: 'Instructions' },
  ]);
  if (!v?.title) return;
  await run(() =>
    examsApi.updateSection(id.value, s.id, { title: v.title, instructions: v.instructions || null }),
  );
  await load();
}

async function removeSection(sectionId: number) {
  if (!(await confirm('Remove section?', 'Only empty sections can be removed.')).ok) return;
  await run(() => examsApi.removeSection(id.value, sectionId), 'Section removed');
  await load();
}

async function editMarks(eq: ExamQuestionDto) {
  const v = await prompt('Marks for this question', [
    { name: 'marks', value: eq.marks, type: 'number', placeholder: 'Marks' },
    { name: 'negativeMarks', value: eq.negativeMarks, type: 'number', placeholder: 'Negative marks' },
  ]);
  if (!v) return;
  const r = await run(() =>
    examsApi.updateQuestion(id.value, eq.id, {
      marks: Number(v.marks),
      negativeMarks: Number(v.negativeMarks || 0),
    }),
  );
  if (r) exam.value = r;
}

async function refresh(eqId: number) {
  const r = await run(() => examsApi.refreshQuestion(id.value, eqId), 'Question refreshed from the bank');
  if (r) exam.value = r;
}

async function removeQuestion(eqId: number) {
  await run(() => examsApi.removeQuestion(id.value, eqId));
  await load();
}

async function searchQuestions() {
  const r = await run(() =>
    questionBankApi.questions({
      pageSize: 50,
      status: 'active',
      bankId: picker.bankId,
      type: picker.type || undefined,
      difficulty: picker.difficulty || undefined,
      q: picker.q || undefined,
      subjectId: exam.value?.subjectId ?? undefined,
    }),
  );
  picker.items = r?.items ?? [];
}

async function openPicker(sectionId: number) {
  Object.assign(picker, {
    open: true,
    sectionId,
    selected: new Set<number>(),
    marks: null,
    negativeMarks: null,
  });
  if (!banks.value.length) banks.value = (await run(() => questionBankApi.banks())) ?? [];
  await searchQuestions();
}

watch(
  () => [picker.bankId, picker.type, picker.difficulty, picker.q],
  () => picker.open && searchQuestions(),
);

function toggle(qid: number, on: boolean) {
  if (on) picker.selected.add(qid);
  else picker.selected.delete(qid);
}

async function addSelected() {
  const num = (v: number | null) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const r = await run(
    () =>
      examsApi.addQuestions(id.value, {
        sectionId: picker.sectionId,
        questionIds: [...picker.selected],
        marks: num(picker.marks),
        negativeMarks: num(picker.negativeMarks),
      }),
    'Questions added',
  );
  if (r) {
    exam.value = r;
    picker.open = false;
  }
}
</script>

<style scoped>
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 0 12px 12px;
}
</style>
