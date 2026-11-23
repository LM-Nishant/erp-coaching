<template>
  <router-link
    :to="`/market/course/${course.slug}`"
    class="course-card"
    :data-testid="`course-${course.slug}`"
  >
    <div class="thumb">
      <img v-if="course.thumbnailUrl" :src="course.thumbnailUrl" :alt="''" loading="lazy" />
      <div v-else class="thumb-fallback">{{ course.title.charAt(0) }}</div>
    </div>
    <div class="body">
      <h3>{{ course.title }}</h3>
      <p class="seller">{{ course.seller.displayName }}</p>
      <p class="meta">
        <span v-if="course.ratingCount" class="rating"
          >★ {{ course.ratingAvg.toFixed(1) }} ({{ course.ratingCount }})</span
        >
        <span>{{ MKT_COURSE_LEVEL_LABELS[course.level] }}</span>
        <span v-if="course.durationSeconds">· {{ durationLabel(course.durationSeconds) }}</span>
      </p>
      <p class="price">{{ priceLabel(course) }}</p>
    </div>
  </router-link>
</template>

<script setup lang="ts">
import { MKT_COURSE_LEVEL_LABELS, type MktCourseCardDto } from '@erp/shared';
import { durationLabel, priceLabel } from '../api';

defineProps<{ course: MktCourseCardDto }>();
</script>

<style scoped>
.course-card {
  display: flex;
  flex-direction: column;
  text-decoration: none;
  color: inherit;
  border-radius: 12px;
  overflow: hidden;
  background: var(--ion-card-background, var(--ion-background-color));
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.12);
  height: 100%;
}
.thumb {
  aspect-ratio: 16 / 9;
  background: var(--ion-color-light);
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.thumb-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 40px;
  font-weight: 700;
  color: var(--ion-color-medium);
}
.body {
  padding: 10px 12px 12px;
}
h3 {
  font-size: 15px;
  margin: 0 0 4px;
  line-height: 1.3;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.seller,
.meta {
  font-size: 12px;
  color: var(--ion-color-medium);
  margin: 2px 0;
}
.meta span + span {
  margin-left: 4px;
}
.rating {
  color: var(--ion-color-warning-shade);
  font-weight: 600;
}
.price {
  font-weight: 700;
  margin: 6px 0 0;
}
</style>
