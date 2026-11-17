<template>
  <AppPage
    :title="title"
    :back-href="bankId ? `/question-bank/banks/${bankId}` : '/question-bank'"
    :on-refresh="load"
  >
    <template #actions>
      <ion-button v-if="!isNew && question" v-can="'question-bank.delete'" color="danger" @click="remove"
        ><ion-icon slot="icon-only" :icon="trashOutline"
      /></ion-button>
    </template>

    <form v-if="loaded" @submit.prevent="save">
      <ion-note v-if="readonly" color="medium">You can view this question but not edit it.</ion-note>
      <ion-note v-if="question?.source === 'ai'" color="tertiary">
        AI-generated question — review carefully before using it in exams.
      </ion-note>
      <ion-list>
        <ion-item>
          <ion-select
            v-model="form.type"
            label="Type"
            label-placement="stacked"
            interface="popover"
            :disabled="readonly"
            @ion-change="onTypeChange"
          >
            <ion-select-option v-for="t in QUESTION_TYPES" :key="t" :value="t">{{
              QUESTION_TYPE_LABELS[t]
            }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item>
          <ion-textarea
            v-model="form.text"
            label="Question"
            label-placement="stacked"
            :auto-grow="true"
            :rows="3"
            :readonly="readonly"
            required
          />
        </ion-item>
      </ion-list>

      <ion-list v-if="hasOptions(form.type)">
        <ion-list-header>
          <ion-label
            >Options
            <small class="muted"
              >(tick the correct answer{{ form.type === 'multiple' ? 's' : '' }})</small
            ></ion-label
          >
          <ion-button v-if="!readonly && form.options.length < OPTION_KEYS.length" @click="addOption"
            ><ion-icon slot="icon-only" :icon="add"
          /></ion-button>
        </ion-list-header>
        <ion-item v-for="(o, i) in form.options" :key="o.key">
          <ion-checkbox
            slot="start"
            :checked="form.correct.includes(o.key)"
            :disabled="readonly"
            :aria-label="`Option ${o.key} is correct`"
            @ion-change="toggleCorrect(o.key, $event.detail.checked)"
          />
          <ion-input v-model="o.text" :label="o.key" :readonly="readonly" />
          <img v-if="o.imageUrl" slot="end" :src="o.imageUrl" class="thumb" alt="" />
          <template v-if="!readonly">
            <ion-button
              slot="end"
              fill="clear"
              :aria-label="`Image for option ${o.key}`"
              @click="pickOptionImage(i)"
              ><ion-icon slot="icon-only" :icon="imageOutline"
            /></ion-button>
            <ion-button
              v-if="o.imageFileId"
              slot="end"
              fill="clear"
              color="medium"
              @click="clearOptionImage(i)"
              ><ion-icon slot="icon-only" :icon="closeCircleOutline"
            /></ion-button>
            <ion-button
              v-if="form.options.length > 2"
              slot="end"
              fill="clear"
              color="danger"
              @click="removeOption(i)"
              ><ion-icon slot="icon-only" :icon="removeCircleOutline"
            /></ion-button>
          </template>
        </ion-item>
        <input ref="optionFile" type="file" accept="image/*" hidden @change="optionImagePicked" />
      </ion-list>

      <ion-list v-else>
        <ion-list-header><ion-label>Answer key</ion-label></ion-list-header>
        <template v-if="form.type === 'true_false'">
          <ion-radio-group v-model="form.tfValue">
            <ion-item><ion-radio :value="true" :disabled="readonly">True</ion-radio></ion-item>
            <ion-item><ion-radio :value="false" :disabled="readonly">False</ion-radio></ion-item>
          </ion-radio-group>
        </template>
        <template v-else-if="form.type === 'numerical'">
          <ion-segment v-model="form.numMode" :disabled="readonly">
            <ion-segment-button value="exact"><ion-label>Value ± tolerance</ion-label></ion-segment-button>
            <ion-segment-button value="range"><ion-label>Range</ion-label></ion-segment-button>
          </ion-segment>
          <template v-if="form.numMode === 'exact'">
            <ion-item>
              <ion-input
                v-model="form.numValue"
                type="number"
                label="Correct value"
                label-placement="stacked"
                :readonly="readonly"
              />
            </ion-item>
            <ion-item>
              <ion-input
                v-model="form.tolerance"
                type="number"
                label="Tolerance (±)"
                label-placement="stacked"
                min="0"
                :readonly="readonly"
              />
            </ion-item>
          </template>
          <template v-else>
            <ion-item>
              <ion-input
                v-model="form.min"
                type="number"
                label="Minimum"
                label-placement="stacked"
                :readonly="readonly"
              />
            </ion-item>
            <ion-item>
              <ion-input
                v-model="form.max"
                type="number"
                label="Maximum"
                label-placement="stacked"
                :readonly="readonly"
              />
            </ion-item>
          </template>
        </template>
        <template v-else>
          <ion-item>
            <ion-textarea
              v-model="form.modelAnswer"
              label="Model answer"
              label-placement="stacked"
              :auto-grow="true"
              :readonly="readonly"
            />
          </ion-item>
          <ion-item>
            <ion-textarea
              v-model="form.rubric"
              label="Rubric / marking scheme"
              label-placement="stacked"
              :auto-grow="true"
              :readonly="readonly"
            />
          </ion-item>
        </template>
      </ion-list>

      <ion-list>
        <ion-list-header><ion-label>Details</ion-label></ion-list-header>
        <ion-item>
          <ion-textarea
            v-model="form.explanation"
            label="Explanation / solution"
            label-placement="stacked"
            :auto-grow="true"
            :readonly="readonly"
          />
        </ion-item>
        <ion-item>
          <ion-select
            v-model="form.difficulty"
            label="Difficulty"
            label-placement="stacked"
            interface="popover"
            :disabled="readonly"
          >
            <ion-select-option v-for="d in QUESTION_DIFFICULTIES" :key="d" :value="d">{{
              d
            }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item>
          <ion-select
            v-model="form.status"
            label="Status"
            label-placement="stacked"
            interface="popover"
            :disabled="readonly"
          >
            <ion-select-option v-for="s in QUESTION_STATUSES" :key="s" :value="s">{{ s }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item>
          <ion-input
            v-model="form.tagsText"
            label="Tags"
            label-placement="stacked"
            helper-text="Comma separated, e.g. JEE, previous-year"
            :readonly="readonly"
          />
        </ion-item>
        <ion-item>
          <ion-input
            v-model="form.defaultMarks"
            type="number"
            label="Default marks"
            label-placement="stacked"
            :readonly="readonly"
          />
        </ion-item>
        <ion-item>
          <ion-input
            v-model="form.defaultNegativeMarks"
            type="number"
            label="Default negative marks"
            label-placement="stacked"
            min="0"
            :readonly="readonly"
          />
        </ion-item>
        <ion-item>
          <ion-select
            v-model="form.subjectId"
            label="Subject"
            label-placement="stacked"
            interface="popover"
            :disabled="readonly"
            @ion-change="onSubjectChange"
          >
            <ion-select-option :value="null">None</ion-select-option>
            <ion-select-option v-for="s in subjects" :key="s.id" :value="s.id">{{
              s.name
            }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item v-if="chapters.length">
          <ion-select
            v-model="form.chapterId"
            label="Chapter"
            label-placement="stacked"
            interface="popover"
            :disabled="readonly"
            @ion-change="form.topicId = null"
          >
            <ion-select-option :value="null">None</ion-select-option>
            <ion-select-option v-for="c in chapters" :key="c.id" :value="c.id">{{
              c.name
            }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item v-if="topicsOf(form.chapterId).length">
          <ion-select
            v-model="form.topicId"
            label="Topic"
            label-placement="stacked"
            interface="popover"
            :disabled="readonly"
          >
            <ion-select-option :value="null">None</ion-select-option>
            <ion-select-option v-for="t in topicsOf(form.chapterId)" :key="t.id" :value="t.id">{{
              t.name
            }}</ion-select-option>
          </ion-select>
        </ion-item>
      </ion-list>

      <ion-list v-if="question">
        <ion-list-header>
          <ion-label>Images & attachments</ion-label>
          <ion-button v-if="!readonly" @click="assetFile?.click()"
            ><ion-icon slot="icon-only" :icon="add"
          /></ion-button>
        </ion-list-header>
        <ion-item v-if="!readonly">
          <ion-select v-model="assetRole" label="Upload as" interface="popover">
            <ion-select-option value="question">Question image</ion-select-option>
            <ion-select-option value="explanation">Explanation image</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item v-for="a in question.assets" :key="a.id">
          <img v-if="!/\.pdf$/i.test(a.originalName)" slot="start" :src="a.url" class="thumb" alt="" />
          <ion-label>
            <a :href="a.url" target="_blank" rel="noopener">{{ a.originalName }}</a>
            <p>{{ a.role === 'question' ? 'Question' : 'Explanation' }}</p>
          </ion-label>
          <ion-button v-if="!readonly" slot="end" fill="clear" color="danger" @click="removeAsset(a.id)"
            ><ion-icon slot="icon-only" :icon="trashOutline"
          /></ion-button>
        </ion-item>
        <ion-item v-if="!question.assets.length"
          ><ion-label class="muted">No attachments.</ion-label></ion-item
        >
        <input ref="assetFile" type="file" accept="image/*,.pdf" hidden @change="assetPicked" />
      </ion-list>

      <ion-button v-if="!readonly" expand="block" type="submit" :disabled="saving">Save</ion-button>
    </form>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  IonButton,
  IonCheckbox,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonNote,
  IonRadio,
  IonRadioGroup,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonTextarea,
  alertController,
  onIonViewWillEnter,
  useIonRouter,
} from '@ionic/vue';
import { add, closeCircleOutline, imageOutline, removeCircleOutline, trashOutline } from 'ionicons/icons';
import {
  QUESTION_DIFFICULTIES,
  QUESTION_STATUSES,
  QUESTION_TYPES,
  QUESTION_TYPE_LABELS,
  type AnswerKey,
  type QuestionDifficulty,
  type QuestionDto,
  type QuestionInput,
  type QuestionStatus,
  type QuestionType,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { questionBankApi } from './api';
import { OPTION_KEYS, hasOptions, parseTags, useAcademicPickers } from './helpers';

interface OptionForm {
  key: string;
  text: string;
  imageFileId: number | null;
  imageUrl: string | null;
}

type Num = number | string | null | undefined;

const route = useRoute();
const router = useRouter();
const ionRouter = useIonRouter();
const auth = useAuthStore();
const { subjects, chapters, loadSubjects, loadChapters, topicsOf } = useAcademicPickers();

const isNew = computed(() => route.name === 'question-new');
const bankId = ref<number | null>(null);
const question = ref<QuestionDto | null>(null);
const loaded = ref(false);
const saving = ref(false);
const readonly = computed(() => !auth.can(isNew.value ? 'question-bank.create' : 'question-bank.edit'));
const title = computed(() => (isNew.value ? 'New question' : readonly.value ? 'Question' : 'Edit question'));

const optionFile = ref<HTMLInputElement | null>(null);
const optionTarget = ref(0);
const assetFile = ref<HTMLInputElement | null>(null);
const assetRole = ref<'question' | 'explanation'>('question');

const emptyOptions = (): OptionForm[] =>
  OPTION_KEYS.slice(0, 4).map((key) => ({ key, text: '', imageFileId: null, imageUrl: null }));

const form = reactive({
  type: 'single' as QuestionType,
  text: '',
  options: emptyOptions(),
  correct: [] as string[],
  tfValue: null as boolean | null,
  numMode: 'exact' as 'exact' | 'range',
  numValue: null as Num,
  tolerance: null as Num,
  min: null as Num,
  max: null as Num,
  modelAnswer: '',
  rubric: '',
  explanation: '',
  difficulty: 'medium' as QuestionDifficulty,
  status: 'active' as QuestionStatus,
  tagsText: '',
  defaultMarks: 1 as Num,
  defaultNegativeMarks: 0 as Num,
  subjectId: null as number | null,
  chapterId: null as number | null,
  topicId: null as number | null,
});

const toNum = (v: Num) => (v === null || v === undefined || v === '' ? undefined : Number(v));

function fill(q?: QuestionDto, subjectId: number | null = null) {
  const k: AnswerKey = q?.answerKey ?? {};
  Object.assign(form, {
    type: q?.type ?? 'single',
    text: q?.text ?? '',
    options: q?.options.length
      ? q.options.map((o) => ({
          key: o.key,
          text: o.text,
          imageFileId: o.imageFileId ?? null,
          imageUrl: o.imageUrl ?? null,
        }))
      : emptyOptions(),
    correct: [...(k.options ?? [])],
    tfValue: typeof k.value === 'boolean' ? k.value : null,
    numMode: k.min != null || k.max != null ? 'range' : 'exact',
    numValue: typeof k.value === 'number' ? k.value : null,
    tolerance: k.tolerance ?? null,
    min: k.min ?? null,
    max: k.max ?? null,
    modelAnswer: k.modelAnswer ?? '',
    rubric: k.rubric ?? '',
    explanation: q?.explanation ?? '',
    difficulty: q?.difficulty ?? 'medium',
    status: q?.status ?? 'active',
    tagsText: q?.tags.join(', ') ?? '',
    defaultMarks: q?.defaultMarks ?? 1,
    defaultNegativeMarks: q?.defaultNegativeMarks ?? 0,
    subjectId: q ? q.subjectId : subjectId,
    chapterId: q?.chapterId ?? null,
    topicId: q?.topicId ?? null,
  });
}

async function load() {
  try {
    if (isNew.value) {
      bankId.value = Number(route.params.bankId);
      question.value = null;
      const bank = await questionBankApi.bank(bankId.value);
      fill(undefined, bank.subjectId);
    } else {
      question.value = await questionBankApi.question(Number(route.params.id));
      bankId.value = question.value.bankId;
      fill(question.value);
    }
    loaded.value = true;
    await Promise.all([loadSubjects(), loadChapters(form.subjectId)]);
  } catch (e) {
    await toastError(e);
  }
}

function onTypeChange() {
  if (form.type === 'single' && form.correct.length > 1) form.correct = form.correct.slice(0, 1);
}

async function onSubjectChange() {
  form.chapterId = null;
  form.topicId = null;
  await loadChapters(form.subjectId);
}

function toggleCorrect(key: string, checked: boolean) {
  if (!checked) form.correct = form.correct.filter((k) => k !== key);
  else form.correct = form.type === 'single' ? [key] : [...new Set([...form.correct, key])];
}

function addOption() {
  form.options.push({ key: OPTION_KEYS[form.options.length], text: '', imageFileId: null, imageUrl: null });
}

function removeOption(i: number) {
  const removed = form.options[i].key;
  const remaining = form.options.filter((_, j) => j !== i);
  const remap = new Map(remaining.map((o, j) => [o.key, OPTION_KEYS[j]]));
  form.options = remaining.map((o, j) => ({ ...o, key: OPTION_KEYS[j] }));
  form.correct = form.correct.filter((k) => k !== removed).map((k) => remap.get(k) ?? k);
}

function pickOptionImage(i: number) {
  optionTarget.value = i;
  optionFile.value?.click();
}

function clearOptionImage(i: number) {
  form.options[i].imageFileId = null;
  form.options[i].imageUrl = null;
}

async function optionImagePicked(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || !bankId.value) return;
  try {
    const res = await questionBankApi.optionImage(bankId.value, file, file.name);
    const o = form.options[optionTarget.value];
    o.imageFileId = res.fileId;
    o.imageUrl = res.url;
  } catch (e) {
    await toastError(e);
  }
}

function answerKey(): AnswerKey {
  switch (form.type) {
    case 'single':
    case 'multiple': {
      const keys = new Set(form.options.map((o) => o.key));
      return { options: form.correct.filter((k) => keys.has(k)).sort() };
    }
    case 'true_false':
      return form.tfValue === null ? {} : { value: form.tfValue };
    case 'numerical':
      return form.numMode === 'exact'
        ? { value: toNum(form.numValue), tolerance: toNum(form.tolerance) }
        : { min: toNum(form.min), max: toNum(form.max) };
    case 'descriptive':
      return { modelAnswer: form.modelAnswer.trim() || undefined, rubric: form.rubric.trim() || undefined };
  }
}

function body(): QuestionInput {
  return {
    type: form.type,
    text: form.text.trim(),
    options: hasOptions(form.type)
      ? form.options.map((o) => ({ key: o.key, text: o.text.trim(), imageFileId: o.imageFileId }))
      : [],
    answerKey: answerKey(),
    explanation: form.explanation.trim() || null,
    difficulty: form.difficulty,
    tags: parseTags(form.tagsText),
    subjectId: form.subjectId,
    chapterId: form.chapterId,
    topicId: form.topicId,
    defaultMarks: toNum(form.defaultMarks) ?? 1,
    defaultNegativeMarks: toNum(form.defaultNegativeMarks) ?? 0,
    status: form.status,
  };
}

async function save() {
  if (hasOptions(form.type) && !form.correct.length) {
    await toastError(new Error('Tick at least one correct option'));
    return;
  }
  saving.value = true;
  try {
    if (question.value) {
      question.value = await questionBankApi.updateQuestion(question.value.id, body());
      await toast('Saved');
    } else if (bankId.value) {
      const q = await questionBankApi.createQuestion(bankId.value, body());
      await toast('Saved');
      await router.replace(`/question-bank/questions/${q.id}`);
    }
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

async function remove() {
  const q = question.value;
  if (!q) return;
  const alert = await alertController.create({
    header: 'Delete this question?',
    message: 'Questions already used in exams may not be deletable; archive them instead.',
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      {
        text: 'Delete',
        role: 'destructive',
        handler: () =>
          questionBankApi
            .removeQuestion(q.id)
            .then(() => toast('Deleted'))
            .then(() =>
              ionRouter.canGoBack()
                ? ionRouter.back()
                : ionRouter.replace(`/question-bank/banks/${q.bankId}`),
            )
            .catch(toastError),
      },
    ],
  });
  await alert.present();
}

async function assetPicked(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file || !question.value) return;
  try {
    question.value = await questionBankApi.addAsset(question.value.id, file, file.name, assetRole.value);
    await toast('Uploaded');
  } catch (e) {
    await toastError(e);
  }
}

async function removeAsset(assetId: number) {
  if (!question.value) return;
  try {
    question.value = await questionBankApi.removeAsset(question.value.id, assetId);
  } catch (e) {
    await toastError(e);
  }
}

onIonViewWillEnter(load);
</script>

<style scoped>
.thumb {
  width: 48px;
  height: 48px;
  object-fit: contain;
}
ion-note {
  display: block;
  margin-bottom: 8px;
}
</style>
