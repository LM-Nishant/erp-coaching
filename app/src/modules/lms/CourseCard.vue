<template>
  <ion-card :router-link="link ? `/lms/courses/${course.id}` : undefined" :button="link">
    <ion-card-header>
      <ion-card-title>{{ course.name }}</ion-card-title>
      <ion-card-subtitle>
        {{ course.completedCount }} / {{ course.resourceCount }} completed
        <span v-if="!course.entitled"> · free content only</span>
        <span v-else-if="course.entitlementUntil">
          · access until {{ new Date(course.entitlementUntil).toLocaleDateString() }}</span
        >
      </ion-card-subtitle>
    </ion-card-header>
    <ion-card-content><ion-progress-bar :value="course.percent / 100" /></ion-card-content>
  </ion-card>
</template>

<script setup lang="ts">
import {
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardSubtitle,
  IonCardTitle,
  IonProgressBar,
} from '@ionic/vue';
import type { LmsLibraryCourseDto } from '@erp/shared';

defineProps<{ course: LmsLibraryCourseDto; link: boolean }>();
</script>
