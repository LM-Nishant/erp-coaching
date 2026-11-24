<template>
  <AppPage title="Course reviews" :on-refresh="load">
    <ion-segment v-model="status" scrollable @ion-change="load">
      <ion-segment-button v-for="s in STATUSES" :key="s" :value="s">
        <ion-label>{{ MKT_COURSE_STATUS_LABELS[s] }}</ion-label>
      </ion-segment-button>
    </ion-segment>
    <ion-list>
      <ion-item
        v-for="i in items"
        :key="i.course.id"
        button
        :router-link="`/admin/marketplace/courses/${i.course.id}`"
        :data-testid="`review-${i.course.id}`"
      >
        <ion-label>
          <h3>{{ i.course.title }}</h3>
          <p>
            {{ i.seller.displayName }} ({{ i.seller.type === 'institute' ? 'institute' : 'instructor' }}) ·
            {{ priceLabel({ isFree: !i.course.pricePaise, pricePaise: i.course.pricePaise }) }} ·
            {{ i.course.lectureCount }} lectures
          </p>
          <p v-if="i.course.submittedAt">Submitted {{ formatDateTime(i.course.submittedAt) }}</p>
        </ion-label>
        <ion-badge slot="end" :color="STATUS_COLORS[i.course.status]">{{
          MKT_COURSE_STATUS_LABELS[i.course.status]
        }}</ion-badge>
      </ion-item>
    </ion-list>
    <p v-if="loaded && !items.length" class="muted">Nothing here.</p>
  </AppPage>
</template>

<script setup lang="ts">
import { formatDateTime } from '@/core/format';
import { onMounted, ref } from 'vue';
import { IonBadge, IonItem, IonLabel, IonList, IonSegment, IonSegmentButton } from '@ionic/vue';
import { MKT_COURSE_STATUS_LABELS, type MktCourseStatus, type MktReviewItemDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toastError } from '@/core/toast';
import { STATUS_COLORS } from '../studio/status';
import { adminMarketApi, priceLabel } from '../api';

const STATUSES: MktCourseStatus[] = ['in_review', 'published', 'rejected', 'unpublished', 'draft'];
const status = ref<MktCourseStatus>('in_review');
const items = ref<MktReviewItemDto[]>([]);
const loaded = ref(false);

async function load() {
  try {
    items.value = await adminMarketApi.queue(status.value);
  } catch (e) {
    void toastError(e);
  } finally {
    loaded.value = true;
  }
}
onMounted(load);
</script>

<style scoped>
.muted {
  color: var(--ion-color-medium);
  text-align: center;
}
</style>
