<template>
  <section class="reviews" data-testid="reviews-section">
    <h2>Student feedback</h2>
    <div v-if="summary.ratingCount" class="summary">
      <div class="score">
        <div class="avg" data-testid="rating-avg">{{ summary.ratingAvg.toFixed(1) }}</div>
        <RatingStars :rating="summary.ratingAvg" size="large" />
        <div class="muted">
          {{ summary.ratingCount }} {{ summary.ratingCount === 1 ? 'rating' : 'ratings' }}
        </div>
      </div>
      <div class="bars">
        <button
          v-for="b in bars"
          :key="b.stars"
          type="button"
          class="bar-row"
          :class="{ active: filter === b.stars }"
          :aria-label="`Show ${b.stars}-star reviews (${b.count})`"
          @click="setFilter(b.stars)"
        >
          <span class="bar"><span :style="{ width: `${b.percent}%` }" /></span>
          <RatingStars :rating="b.stars" />
          <span class="pct">{{ b.percent }}%</span>
        </button>
      </div>
    </div>
    <p v-else class="muted">No ratings yet.</p>

    <!-- the signed-in learner's own review -->
    <div v-if="mine.canReview" class="box mine" data-testid="my-review">
      <template v-if="mine.review && !editing">
        <div class="row">
          <strong>Your review</strong>
          <span>
            <ion-button fill="clear" size="small" data-testid="edit-review" @click="startEdit"
              >Edit</ion-button
            >
            <ion-button fill="clear" size="small" color="danger" @click="remove">Delete</ion-button>
          </span>
        </div>
        <RatingStars :rating="mine.review.rating" />
        <p v-if="mine.review.title" class="title">{{ mine.review.title }}</p>
        <p v-if="mine.review.body" class="prose">{{ mine.review.body }}</p>
      </template>
      <form v-else @submit.prevent="save">
        <strong>{{ mine.review ? 'Edit your review' : 'Rate this course' }}</strong>
        <div class="picker" role="radiogroup" aria-label="Your rating">
          <button
            v-for="n in 5"
            :key="n"
            type="button"
            role="radio"
            :aria-checked="form.rating === n"
            :aria-label="`${n} star${n > 1 ? 's' : ''}`"
            :data-testid="`rate-${n}`"
            @click="form.rating = n"
          >
            <ion-icon :icon="n <= form.rating ? star : starOutline" />
          </button>
          <span class="muted">{{ RATING_WORDS[form.rating] }}</span>
        </div>
        <ion-input
          v-model="form.title"
          label="Title (optional)"
          label-placement="stacked"
          fill="outline"
          :maxlength="150"
          data-testid="review-title"
        />
        <ion-textarea
          v-model="form.body"
          label="Tell others about your experience (optional)"
          label-placement="stacked"
          fill="outline"
          :auto-grow="true"
          :rows="3"
          :maxlength="MKT_REVIEW_MAX_BODY"
          data-testid="review-body"
        />
        <div class="row end">
          <ion-button v-if="mine.review" fill="clear" @click="editing = false">Cancel</ion-button>
          <ion-button type="submit" :disabled="!form.rating || busy" data-testid="save-review"
            >Save review</ion-button
          >
        </div>
      </form>
    </div>

    <div v-if="list.total || filter" class="row toolbar">
      <ion-select
        v-model="sort"
        interface="popover"
        label="Sort"
        aria-label="Sort reviews"
        @ion-change="reload"
      >
        <ion-select-option v-for="s in MKT_REVIEW_SORTS" :key="s" :value="s">{{
          MKT_REVIEW_SORT_LABELS[s]
        }}</ion-select-option>
      </ion-select>
      <ion-chip v-if="filter" @click="setFilter(filter)">{{ filter }} stars ✕</ion-chip>
    </div>

    <article v-for="r in list.items" :key="r.id" class="review" :data-testid="`review-${r.id}`">
      <div class="avatar" aria-hidden="true">{{ r.authorName.charAt(0) }}</div>
      <div class="content">
        <strong>{{ r.authorName }}</strong>
        <div class="muted"><RatingStars :rating="r.rating" /> · {{ relativeDate(r.updatedAt) }}</div>
        <p v-if="r.title" class="title">{{ r.title }}</p>
        <p v-if="r.body" class="prose">{{ r.body }}</p>
        <div v-if="r.reply" class="reply">
          <strong>{{ r.reply.sellerName }}</strong>
          <span class="muted"> · instructor response</span>
          <p class="prose">{{ r.reply.body }}</p>
        </div>
        <ion-button
          v-if="auth.isAuthenticated && !r.mine"
          fill="clear"
          size="small"
          color="medium"
          class="report"
          @click="report(r.id)"
          >Report</ion-button
        >
      </div>
    </article>
    <p v-if="filter && !list.total" class="muted">No {{ filter }}-star reviews.</p>
    <ion-button v-if="list.items.length < list.total" fill="outline" :disabled="busy" @click="more"
      >Show more reviews</ion-button
    >
  </section>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { IonButton, IonChip, IonIcon, IonInput, IonSelect, IonSelectOption, IonTextarea } from '@ionic/vue';
import { star, starOutline } from 'ionicons/icons';
import {
  MKT_REVIEW_MAX_BODY,
  MKT_REVIEW_SORT_LABELS,
  MKT_REVIEW_SORTS,
  type MktCourseReviewDto,
  type MktMyReviewDto,
  type MktReviewSort,
  type MktReviewSummaryDto,
} from '@erp/shared';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { breakdownPercents, engagementApi, relativeDate } from '../engagement-api';
import { confirmAction, promptText } from '../prompts';
import RatingStars from './RatingStars.vue';

const RATING_WORDS = ['Select a rating', 'Awful', 'Poor', 'Average', 'Good', 'Amazing'];
const PAGE = 10;

const props = defineProps<{ courseId: number; slug: string; enrolled: boolean }>();
const emit = defineEmits<{ changed: [summary: MktReviewSummaryDto] }>();

const auth = useAuthStore();
const summary = ref<MktReviewSummaryDto>({ ratingAvg: 0, ratingCount: 0, breakdown: [0, 0, 0, 0, 0] });
const list = reactive<{ items: MktCourseReviewDto[]; total: number; page: number }>({
  items: [],
  total: 0,
  page: 1,
});
const mine = ref<MktMyReviewDto>({ canReview: false, review: null });
const sort = ref<MktReviewSort>('recent');
const filter = ref<number | null>(null);
const editing = ref(false);
const busy = ref(false);
const form = reactive({ rating: 0, title: '', body: '' });
const bars = computed(() => breakdownPercents(summary.value.breakdown));

async function fetchPage(page: number) {
  const res = await engagementApi.reviews(props.slug, {
    sort: sort.value,
    rating: filter.value ?? undefined,
    page,
    pageSize: PAGE,
  });
  summary.value = res.summary;
  list.items = page === 1 ? res.items : [...list.items, ...res.items];
  list.total = res.total;
  list.page = page;
  return res;
}

async function reload() {
  try {
    await fetchPage(1);
  } catch (e) {
    void toastError(e);
  }
}

async function more() {
  busy.value = true;
  try {
    await fetchPage(list.page + 1);
  } finally {
    busy.value = false;
  }
}

function setFilter(stars: number) {
  filter.value = filter.value === stars ? null : stars;
  void reload();
}

async function loadMine() {
  mine.value = { canReview: false, review: null };
  if (!auth.isAuthenticated || auth.offline || !props.enrolled) return;
  try {
    mine.value = await engagementApi.myReview(props.courseId);
    editing.value = !mine.value.review;
  } catch {
    /* reviews stay read-only */
  }
}

function startEdit() {
  const r = mine.value.review;
  Object.assign(form, { rating: r?.rating ?? 0, title: r?.title ?? '', body: r?.body ?? '' });
  editing.value = true;
}

async function save() {
  busy.value = true;
  try {
    mine.value = await engagementApi.saveReview(props.courseId, {
      rating: form.rating,
      title: form.title.trim() || null,
      body: form.body.trim() || null,
    });
    editing.value = false;
    await fetchPage(1);
    emit('changed', summary.value);
    await toast('Thanks for your review');
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

async function remove() {
  if (!(await confirmAction('Delete review', 'Delete your rating and review for this course?'))) return;
  try {
    await engagementApi.deleteReview(props.courseId);
    mine.value = { canReview: true, review: null };
    Object.assign(form, { rating: 0, title: '', body: '' });
    editing.value = true;
    await fetchPage(1);
    emit('changed', summary.value);
  } catch (e) {
    void toastError(e);
  }
}

async function report(id: number) {
  const reason = await promptText({
    header: 'Report review',
    message: 'Tell us what is wrong with this review (spam, abuse, off-topic…).',
    placeholder: 'Reason',
    confirm: 'Report',
  });
  if (!reason) return;
  try {
    await engagementApi.reportReview(id, reason);
    await toast('Thanks — our team will take a look');
  } catch (e) {
    void toastError(e);
  }
}

watch(
  () => [props.slug, props.enrolled, auth.isAuthenticated] as const,
  () => {
    Object.assign(form, { rating: 0, title: '', body: '' });
    void reload();
    void loadMine();
  },
  { immediate: true },
);
</script>

<style scoped>
h2 {
  font-size: 19px;
}
.summary {
  display: flex;
  gap: 24px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.score {
  text-align: center;
  min-width: 110px;
}
.avg {
  font-size: 44px;
  font-weight: 700;
  color: var(--ion-color-warning-shade);
  line-height: 1;
}
.bars {
  flex: 1;
  min-width: 220px;
}
.bar-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  background: none;
  border: 0;
  padding: 3px 0;
  cursor: pointer;
  color: inherit;
  font: inherit;
}
.bar-row.active .bar {
  outline: 2px solid var(--ion-color-primary);
}
.bar {
  flex: 1;
  height: 8px;
  background: var(--ion-color-light-shade);
  border-radius: 4px;
  overflow: hidden;
}
.bar span {
  display: block;
  height: 100%;
  background: var(--ion-color-medium);
}
.pct {
  width: 36px;
  text-align: right;
  font-size: 12px;
  color: var(--ion-color-medium-shade);
}
.box {
  border: 1px solid var(--ion-color-light-shade);
  border-radius: 12px;
  padding: 12px 16px;
  margin: 12px 0;
}
.mine form {
  display: grid;
  gap: 10px;
}
.picker {
  display: flex;
  align-items: center;
  gap: 2px;
}
.picker button {
  background: none;
  border: 0;
  padding: 2px;
  cursor: pointer;
  color: var(--ion-color-warning-shade);
  font-size: 28px;
  display: flex;
}
.picker .muted {
  margin-left: 8px;
}
.row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.row.end {
  justify-content: flex-end;
}
.toolbar {
  justify-content: flex-start;
  max-width: 360px;
}
.review {
  display: flex;
  gap: 12px;
  padding: 14px 0;
  border-top: 1px solid var(--ion-color-light-shade);
}
.avatar {
  flex: none;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--ion-color-dark);
  color: var(--ion-color-dark-contrast);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
}
.content {
  flex: 1;
  min-width: 0;
}
.title {
  font-weight: 600;
  margin: 6px 0 2px;
}
.prose {
  white-space: pre-wrap;
  line-height: 1.5;
  margin: 4px 0;
}
.reply {
  margin-top: 8px;
  padding: 8px 12px;
  border-left: 3px solid var(--ion-color-primary);
  background: var(--ion-color-light);
  border-radius: 4px;
}
.report {
  margin: 0 0 0 -8px;
}
.muted {
  color: var(--ion-color-medium-shade);
  font-size: 13px;
}
</style>
