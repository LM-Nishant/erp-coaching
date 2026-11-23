<template>
  <AppPage title="Rating moderation" :on-refresh="() => load(1)">
    <ion-segment v-model="view" class="tabs" @ion-change="load(1)">
      <ion-segment-button value="reported"><ion-label>Reported</ion-label></ion-segment-button>
      <ion-segment-button value="hidden"><ion-label>Hidden</ion-label></ion-segment-button>
      <ion-segment-button value="all"><ion-label>All</ion-label></ion-segment-button>
    </ion-segment>
    <p class="muted">
      Learners can report reviews. Hidden reviews disappear from the course page and no longer count towards
      its rating.
    </p>
    <ion-card v-for="r in items" :key="r.id" :data-testid="`moderate-review-${r.id}`">
      <ion-card-header>
        <ion-card-subtitle>
          <router-link :to="`/market/course/${r.course.slug}`">{{ r.course.title }}</router-link>
        </ion-card-subtitle>
        <ion-card-title class="title">
          <RatingStars :rating="r.rating" size="large" />
          <ion-badge v-if="r.status === 'hidden'" color="medium">Hidden</ion-badge>
          <ion-badge v-if="r.reportCount" color="danger"
            >{{ r.reportCount }} {{ r.reportCount === 1 ? 'report' : 'reports' }}</ion-badge
          >
        </ion-card-title>
      </ion-card-header>
      <ion-card-content>
        <p class="muted">{{ r.authorName }} · {{ relativeDate(r.updatedAt) }}</p>
        <p v-if="r.title" class="strong">{{ r.title }}</p>
        <p v-if="r.body" class="prose">{{ r.body }}</p>
        <ul v-if="r.reports.length" class="reports">
          <li v-for="(rep, i) in r.reports" :key="i">
            “{{ rep.reason }}” · {{ relativeDate(rep.createdAt) }}
          </li>
        </ul>
        <p v-if="r.hiddenReason" class="muted">Hidden: {{ r.hiddenReason }}</p>
        <div class="row">
          <ion-button
            v-if="r.status === 'visible'"
            size="small"
            color="danger"
            :data-testid="`hide-review-${r.id}`"
            @click="hide(r)"
            >Hide review</ion-button
          >
          <ion-button v-else size="small" fill="outline" @click="unhide(r)">Restore</ion-button>
        </div>
      </ion-card-content>
    </ion-card>
    <p v-if="loaded && !items.length" class="muted empty">Nothing to moderate.</p>
    <ion-button v-if="items.length < total" fill="clear" expand="block" @click="load(page + 1)"
      >Load more</ion-button
    >
  </AppPage>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import {
  IonBadge,
  IonButton,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardSubtitle,
  IonCardTitle,
  IonLabel,
  IonSegment,
  IonSegmentButton,
} from '@ionic/vue';
import type { MktManagedReviewDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import RatingStars from '../components/RatingStars.vue';
import { adminReviewsApi, relativeDate } from '../engagement-api';
import { promptText } from '../prompts';

const view = ref<'reported' | 'hidden' | 'all'>('reported');
const items = ref<MktManagedReviewDto[]>([]);
const total = ref(0);
const page = ref(1);
const loaded = ref(false);

async function load(p: number) {
  try {
    const res = await adminReviewsApi.list({
      page: p,
      reported: view.value === 'reported' || undefined,
      status: view.value === 'hidden' ? 'hidden' : view.value === 'reported' ? 'visible' : undefined,
    });
    items.value = p === 1 ? res.items : [...items.value, ...res.items];
    total.value = res.total;
    page.value = p;
    loaded.value = true;
  } catch (e) {
    void toastError(e);
  }
}

function replace(r: MktManagedReviewDto) {
  items.value = items.value.map((x) => (x.id === r.id ? r : x));
}

async function hide(r: MktManagedReviewDto) {
  const reason = await promptText({
    header: 'Hide review',
    message: 'The learner keeps their enrolment; the review is removed from the course page.',
    placeholder: 'Reason',
    confirm: 'Hide',
  });
  if (reason === null) return;
  try {
    replace(await adminReviewsApi.hide(r.id, reason));
    await toast('Review hidden');
  } catch (e) {
    void toastError(e);
  }
}

async function unhide(r: MktManagedReviewDto) {
  try {
    replace(await adminReviewsApi.unhide(r.id));
    await toast('Review restored');
  } catch (e) {
    void toastError(e);
  }
}

void load(1);
</script>

<style scoped>
.tabs {
  max-width: 480px;
}
.title {
  font-size: 17px;
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.reports {
  font-size: 13px;
  padding-left: 18px;
  color: var(--ion-color-danger-shade);
}
.row {
  display: flex;
  justify-content: flex-end;
}
.prose {
  white-space: pre-wrap;
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
