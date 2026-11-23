<template>
  <section class="qa" data-testid="qa-panel">
    <template v-if="open">
      <ion-button fill="clear" size="small" class="back" @click="closeQuestion">
        <ion-icon slot="start" :icon="arrowBack" />All questions
      </ion-button>
      <article class="question">
        <div class="row">
          <h3 data-testid="qa-question-title">{{ open.title }}</h3>
          <ion-badge v-if="open.answered" color="success">Answered</ion-badge>
        </div>
        <p class="muted">
          {{ open.authorName }} · {{ relativeDate(open.createdAt) }}
          <template v-if="open.lectureTitle"> · {{ open.lectureTitle }}</template>
        </p>
        <p v-if="open.body" class="prose">{{ open.body }}</p>
        <div class="row actions">
          <ion-button
            v-if="open.mine"
            size="small"
            fill="outline"
            data-testid="qa-toggle-answered"
            @click="toggleAnswered"
            >{{ open.answered ? 'Reopen' : 'Mark answered' }}</ion-button
          >
          <ion-button v-if="open.mine" size="small" fill="clear" color="danger" @click="removeQuestion"
            >Delete</ion-button
          >
        </div>
      </article>
      <h4>{{ open.answerCount }} {{ open.answerCount === 1 ? 'answer' : 'answers' }}</h4>
      <div v-for="a in open.answers ?? []" :key="a.id" class="answer" :class="{ instructor: a.isInstructor }">
        <strong>{{ a.authorName }}</strong>
        <ion-badge v-if="a.isInstructor" color="primary" class="tag">Instructor</ion-badge>
        <span class="muted"> · {{ relativeDate(a.createdAt) }}</span>
        <p class="prose">{{ a.body }}</p>
      </div>
      <form class="compose" @submit.prevent="sendAnswer">
        <ion-textarea
          v-model="answerText"
          label="Write your answer"
          label-placement="stacked"
          fill="outline"
          :auto-grow="true"
          :rows="2"
          :maxlength="MKT_QA_MAX_BODY"
          data-testid="qa-answer-body"
        />
        <ion-button type="submit" :disabled="!answerText.trim() || busy" data-testid="qa-answer-send"
          >Add answer</ion-button
        >
      </form>
    </template>

    <template v-else-if="asking">
      <form class="compose" data-testid="qa-ask-form" @submit.prevent="ask">
        <h3>Ask a question</h3>
        <ion-input
          v-model="draft.title"
          label="Title or summary"
          label-placement="stacked"
          fill="outline"
          :maxlength="200"
          data-testid="qa-ask-title"
        />
        <ion-textarea
          v-model="draft.body"
          label="Details (optional)"
          label-placement="stacked"
          fill="outline"
          :auto-grow="true"
          :rows="3"
          :maxlength="MKT_QA_MAX_BODY"
          data-testid="qa-ask-body"
        />
        <ion-checkbox v-if="lectureId" v-model="draft.aboutLecture" label-placement="end"
          >About this lecture{{ lectureTitle ? `: ${lectureTitle}` : '' }}</ion-checkbox
        >
        <div class="row end">
          <ion-button fill="clear" @click="asking = false">Cancel</ion-button>
          <ion-button type="submit" :disabled="!draft.title.trim() || busy" data-testid="qa-ask-send"
            >Publish</ion-button
          >
        </div>
      </form>
    </template>

    <template v-else>
      <div class="row">
        <ion-searchbar
          v-model="search"
          :debounce="350"
          placeholder="Search questions"
          class="search"
          @ion-input="reload"
        />
        <ion-button data-testid="qa-ask" @click="startAsk">Ask a question</ion-button>
      </div>
      <div class="filters">
        <ion-segment v-model="scopeFilter" @ion-change="reload">
          <ion-segment-button value="course"><ion-label>All lectures</ion-label></ion-segment-button>
          <ion-segment-button value="lecture" :disabled="!lectureId"
            ><ion-label>This lecture</ion-label></ion-segment-button
          >
        </ion-segment>
        <ion-select v-model="filter" interface="popover" aria-label="Filter questions" @ion-change="reload">
          <ion-select-option value="all">All questions</ion-select-option>
          <ion-select-option value="unanswered">Unanswered</ion-select-option>
          <ion-select-option value="mine">My questions</ion-select-option>
        </ion-select>
      </div>
      <ion-list lines="full">
        <ion-item
          v-for="q in items"
          :key="q.id"
          button
          :detail="false"
          :data-testid="`qa-question-${q.id}`"
          @click="openQuestion(q.id)"
        >
          <ion-label class="ion-text-wrap">
            <h3>{{ q.title }}</h3>
            <p>
              {{ q.authorName }} · {{ relativeDate(q.createdAt) }}
              <template v-if="q.lectureTitle"> · {{ q.lectureTitle }}</template>
            </p>
          </ion-label>
          <div slot="end" class="count" :class="{ done: q.answered }">
            <ion-icon :icon="q.answered ? checkmarkCircle : chatbubbleOutline" />
            {{ q.answerCount }}
          </div>
        </ion-item>
      </ion-list>
      <p v-if="loaded && !items.length" class="muted empty">
        No questions yet. Ask the instructor and other learners.
      </p>
      <ion-button v-if="items.length < total" fill="clear" @click="more">Load more</ion-button>
    </template>
  </section>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import {
  IonBadge,
  IonButton,
  IonCheckbox,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonSearchbar,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonTextarea,
} from '@ionic/vue';
import { arrowBack, chatbubbleOutline, checkmarkCircle } from 'ionicons/icons';
import { MKT_QA_MAX_BODY, type MktQuestionDto, type MktQuestionQuery } from '@erp/shared';
import { toast, toastError } from '@/core/toast';
import { engagementApi, relativeDate } from '../engagement-api';
import { confirmAction } from '../prompts';

const props = defineProps<{
  courseId: number;
  lectureId: number | null;
  lectureTitle?: string;
  /** Opens this question first (from a notification link). */
  questionId?: number | null;
}>();

const items = ref<MktQuestionDto[]>([]);
const total = ref(0);
const page = ref(1);
const loaded = ref(false);
const search = ref('');
const filter = ref<NonNullable<MktQuestionQuery['filter']>>('all');
const scopeFilter = ref<'course' | 'lecture'>('course');
const open = ref<MktQuestionDto | null>(null);
const asking = ref(false);
const busy = ref(false);
const answerText = ref('');
const draft = reactive({ title: '', body: '', aboutLecture: true });

function query(p: number): MktQuestionQuery {
  return {
    page: p,
    pageSize: 20,
    filter: filter.value,
    q: search.value.trim() || undefined,
    lectureId: scopeFilter.value === 'lecture' && props.lectureId ? props.lectureId : undefined,
  };
}

async function reload() {
  try {
    const res = await engagementApi.questions(props.courseId, query(1));
    items.value = res.items;
    total.value = res.total;
    page.value = 1;
    loaded.value = true;
  } catch (e) {
    void toastError(e);
  }
}

async function more() {
  const res = await engagementApi.questions(props.courseId, query(page.value + 1));
  items.value = [...items.value, ...res.items];
  total.value = res.total;
  page.value += 1;
}

async function openQuestion(id: number) {
  try {
    open.value = await engagementApi.question(props.courseId, id);
    answerText.value = '';
  } catch (e) {
    void toastError(e);
  }
}

function closeQuestion() {
  open.value = null;
  void reload();
}

function startAsk() {
  Object.assign(draft, { title: '', body: '', aboutLecture: !!props.lectureId });
  asking.value = true;
}

async function ask() {
  busy.value = true;
  try {
    open.value = await engagementApi.ask(props.courseId, {
      title: draft.title.trim(),
      body: draft.body.trim() || null,
      lectureId: draft.aboutLecture && props.lectureId ? props.lectureId : null,
    });
    asking.value = false;
    await toast('Question published');
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

async function sendAnswer() {
  if (!open.value) return;
  busy.value = true;
  try {
    open.value = await engagementApi.answer(props.courseId, open.value.id, answerText.value.trim());
    answerText.value = '';
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

async function toggleAnswered() {
  if (!open.value) return;
  try {
    open.value = await engagementApi.setAnswered(props.courseId, open.value.id, !open.value.answered);
  } catch (e) {
    void toastError(e);
  }
}

async function removeQuestion() {
  if (!open.value || !(await confirmAction('Delete question', 'Delete this question and its answers?')))
    return;
  try {
    await engagementApi.deleteQuestion(props.courseId, open.value.id);
    closeQuestion();
  } catch (e) {
    void toastError(e);
  }
}

watch(
  () => props.lectureId,
  () => scopeFilter.value === 'lecture' && void reload(),
);
watch(
  () => props.questionId,
  (id) => id && void openQuestion(id),
  { immediate: true },
);
void reload();
</script>

<style scoped>
.qa {
  padding: 4px 0 24px;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.row.end {
  justify-content: flex-end;
}
.search {
  flex: 1;
  min-width: 200px;
  padding-inline: 0;
}
.filters {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}
.filters ion-segment {
  max-width: 320px;
}
.count {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--ion-color-medium);
}
.count.done {
  color: var(--ion-color-success);
}
.back {
  margin-left: -8px;
}
.question h3 {
  margin: 0;
  font-size: 18px;
}
.actions {
  justify-content: flex-start;
}
.answer {
  padding: 10px 12px;
  border-top: 1px solid var(--ion-color-light-shade);
}
.answer.instructor {
  background: rgba(var(--ion-color-primary-rgb), 0.06);
  border-radius: 6px;
}
.tag {
  margin-left: 6px;
  vertical-align: 1px;
}
.compose {
  display: grid;
  gap: 10px;
  margin-top: 12px;
}
.compose ion-button[type='submit'] {
  justify-self: end;
}
.prose {
  white-space: pre-wrap;
  line-height: 1.5;
  margin: 6px 0;
}
.muted {
  color: var(--ion-color-medium-shade);
  font-size: 13px;
}
.empty {
  text-align: center;
  padding: 16px;
}
</style>
