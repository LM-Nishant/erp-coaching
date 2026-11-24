<template>
  <AppPage title="Q&A and reviews" :back-href="`/market/studio/${scope}`" :on-refresh="reload">
    <ion-segment v-model="tab" class="tabs" @ion-change="changeTab">
      <ion-segment-button value="qa" data-testid="tab-qa"
        ><ion-label>Questions</ion-label></ion-segment-button
      >
      <ion-segment-button value="reviews" data-testid="tab-reviews"
        ><ion-label>Reviews</ion-label></ion-segment-button
      >
    </ion-segment>

    <div class="filters">
      <ion-select
        v-model="courseId"
        interface="popover"
        label="Course"
        label-placement="stacked"
        fill="outline"
        @ion-change="reload"
      >
        <ion-select-option :value="0">All courses</ion-select-option>
        <ion-select-option v-for="c in courses" :key="c.id" :value="c.id">{{ c.title }}</ion-select-option>
      </ion-select>
      <ion-checkbox v-if="tab === 'qa'" v-model="onlyOpen" label-placement="end" @ion-change="reload"
        >Unanswered only</ion-checkbox
      >
      <ion-checkbox v-else v-model="onlyUnreplied" label-placement="end" @ion-change="reload"
        >Without a reply</ion-checkbox
      >
    </div>

    <template v-if="tab === 'qa'">
      <ion-card v-for="q in questions" :key="q.id" :data-testid="`studio-question-${q.id}`">
        <ion-card-header>
          <ion-card-subtitle
            >{{ q.course.title
            }}<template v-if="q.lectureTitle"> · {{ q.lectureTitle }}</template></ion-card-subtitle
          >
          <ion-card-title class="q-title"
            >{{ q.title }}
            <ion-badge :color="q.answered ? 'success' : 'warning'">{{
              q.answered ? 'Answered' : 'Open'
            }}</ion-badge></ion-card-title
          >
        </ion-card-header>
        <ion-card-content>
          <p class="muted">{{ q.authorName }} · {{ relativeDate(q.createdAt) }}</p>
          <p v-if="q.body" class="prose">{{ q.body }}</p>
          <div v-for="a in q.answers ?? []" :key="a.id" class="answer" :class="{ mine: a.isInstructor }">
            <strong>{{ a.authorName }}</strong>
            <span v-if="a.isInstructor" class="muted"> · instructor</span>
            <p class="prose">{{ a.body }}</p>
          </div>
          <form class="compose" @submit.prevent="answer(q)">
            <ion-textarea
              v-model="drafts[q.id]"
              placeholder="Write an answer"
              fill="outline"
              :auto-grow="true"
              :rows="2"
              :maxlength="MKT_QA_MAX_BODY"
              :data-testid="`studio-answer-${q.id}`"
            />
            <div class="row">
              <ion-button size="small" fill="clear" @click="toggleAnswered(q)">{{
                q.answered ? 'Reopen' : 'Mark answered'
              }}</ion-button>
              <ion-button
                type="submit"
                size="small"
                :disabled="!drafts[q.id]?.trim() || busy"
                :data-testid="`studio-answer-send-${q.id}`"
                >Answer</ion-button
              >
            </div>
          </form>
        </ion-card-content>
      </ion-card>
      <p v-if="loaded && !questions.length" class="muted empty">No questions here.</p>
    </template>

    <template v-else>
      <ion-card v-for="r in reviews" :key="r.id" :data-testid="`studio-review-${r.id}`">
        <ion-card-header>
          <ion-card-subtitle>{{ r.course.title }}</ion-card-subtitle>
          <ion-card-title class="q-title">
            <RatingStars :rating="r.rating" size="large" />
            <ion-badge v-if="r.status === 'hidden'" color="medium">Hidden by moderators</ion-badge>
          </ion-card-title>
        </ion-card-header>
        <ion-card-content>
          <p class="muted">{{ r.authorName }} · {{ relativeDate(r.updatedAt) }}</p>
          <p v-if="r.title" class="strong">{{ r.title }}</p>
          <p v-if="r.body" class="prose">{{ r.body }}</p>
          <form class="compose" @submit.prevent="reply(r)">
            <ion-textarea
              v-model="drafts[r.id]"
              :placeholder="r.reply ? 'Edit your public reply' : 'Reply publicly to this review'"
              fill="outline"
              :auto-grow="true"
              :rows="2"
              :maxlength="MKT_REVIEW_MAX_BODY"
              :data-testid="`studio-reply-${r.id}`"
            />
            <div class="row">
              <ion-button v-if="r.reply" size="small" fill="clear" color="danger" @click="reply(r, true)"
                >Remove reply</ion-button
              >
              <span v-else />
              <ion-button type="submit" size="small" :disabled="!drafts[r.id]?.trim() || busy">{{
                r.reply ? 'Update reply' : 'Reply'
              }}</ion-button>
            </div>
          </form>
        </ion-card-content>
      </ion-card>
      <p v-if="loaded && !reviews.length" class="muted empty">No reviews here.</p>
    </template>
    <ion-button v-if="shown < total" fill="clear" expand="block" @click="more">Load more</ion-button>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  IonBadge,
  IonButton,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardSubtitle,
  IonCardTitle,
  IonCheckbox,
  IonLabel,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonTextarea,
} from '@ionic/vue';
import {
  MKT_QA_MAX_BODY,
  MKT_REVIEW_MAX_BODY,
  type MktManagedReviewDto,
  type MktStudioCourseDto,
  type MktStudioQuestionDto,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { studioApi, type StudioScope } from '../api';
import RatingStars from '../components/RatingStars.vue';
import { relativeDate, studioEngagementApi } from '../engagement-api';

const route = useRoute();
const router = useRouter();
const scope = route.params.scope as StudioScope;
const api = studioEngagementApi(scope);

const tab = ref<'qa' | 'reviews'>(route.query.tab === 'reviews' ? 'reviews' : 'qa');
const courses = ref<MktStudioCourseDto[]>([]);
const courseId = ref(Number(route.query.courseId) || 0);
const onlyOpen = ref(!route.query.questionId);
const onlyUnreplied = ref(false);
const questions = ref<MktStudioQuestionDto[]>([]);
const reviews = ref<MktManagedReviewDto[]>([]);
const total = ref(0);
const page = ref(1);
const loaded = ref(false);
const busy = ref(false);
const drafts = reactive<Record<number, string>>({});
const shown = computed(() => (tab.value === 'qa' ? questions.value.length : reviews.value.length));

async function fetchPage(p: number) {
  const course = courseId.value || undefined;
  if (tab.value === 'qa') {
    const res = await api.questions({
      courseId: course,
      filter: onlyOpen.value ? 'unanswered' : 'all',
      page: p,
    });
    questions.value = p === 1 ? res.items : [...questions.value, ...res.items];
    total.value = res.total;
  } else {
    const res = await api.reviews({ courseId: course, unreplied: onlyUnreplied.value || undefined, page: p });
    reviews.value = p === 1 ? res.items : [...reviews.value, ...res.items];
    for (const r of res.items) drafts[r.id] ??= r.reply?.body ?? '';
    total.value = res.total;
  }
  page.value = p;
  loaded.value = true;
}

async function reload() {
  try {
    await fetchPage(1);
  } catch (e) {
    void toastError(e);
  }
}

const more = () => fetchPage(page.value + 1).catch(toastError);

function changeTab() {
  loaded.value = false;
  void router.replace({ query: { tab: tab.value } });
  void reload();
}

function replaceQuestion(q: MktStudioQuestionDto) {
  questions.value = questions.value.map((x) => (x.id === q.id ? q : x));
}

async function answer(q: MktStudioQuestionDto) {
  busy.value = true;
  try {
    replaceQuestion(await api.answer(q.id, drafts[q.id].trim()));
    drafts[q.id] = '';
    await toast('Answer posted');
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

async function toggleAnswered(q: MktStudioQuestionDto) {
  try {
    replaceQuestion(await api.setAnswered(q.id, !q.answered));
  } catch (e) {
    void toastError(e);
  }
}

async function reply(r: MktManagedReviewDto, remove = false) {
  busy.value = true;
  try {
    const updated = await api.reply(r.id, remove ? null : drafts[r.id].trim());
    reviews.value = reviews.value.map((x) => (x.id === r.id ? updated : x));
    drafts[r.id] = updated.reply?.body ?? '';
    await toast(remove ? 'Reply removed' : 'Reply published');
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  studioApi(scope)
    .courses()
    .then((c) => (courses.value = c.filter((x) => x.status === 'published' || x.publishedAt)))
    .catch(() => undefined);
  await reload();
});
</script>

<style scoped>
.tabs {
  max-width: 420px;
  margin-bottom: 12px;
}
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  align-items: center;
  margin-bottom: 8px;
}
.filters ion-select {
  min-width: 240px;
  max-width: 420px;
}
.q-title {
  font-size: 17px;
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.answer {
  border-left: 3px solid var(--ion-color-light-shade);
  padding: 4px 10px;
  margin: 8px 0;
}
.answer.mine {
  border-color: var(--ion-color-primary);
}
.compose {
  margin-top: 8px;
}
.row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.prose {
  white-space: pre-wrap;
  line-height: 1.5;
}
.strong {
  font-weight: 600;
}
.muted {
  color: var(--ion-color-medium-shade);
  font-size: 13px;
}
.empty {
  text-align: center;
  padding: 24px;
}
</style>
