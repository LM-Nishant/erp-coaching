<template>
  <div class="course-grid" :class="{ scroll }">
    <CourseCard v-for="c in courses" :key="c.id" :course="c" />
  </div>
</template>

<script setup lang="ts">
import type { MktCourseCardDto } from '@erp/shared';
import CourseCard from './CourseCard.vue';

defineProps<{ courses: MktCourseCardDto[]; scroll?: boolean }>();
</script>

<style scoped>
.course-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 16px;
}
/* A horizontally scrolling row on the home page (mobile friendly). */
.course-grid.scroll {
  grid-auto-flow: column;
  grid-template-columns: none;
  grid-auto-columns: minmax(220px, 260px);
  overflow-x: auto;
  padding-bottom: 6px;
  scroll-snap-type: x mandatory;
}
.course-grid.scroll > * {
  scroll-snap-align: start;
}
</style>
