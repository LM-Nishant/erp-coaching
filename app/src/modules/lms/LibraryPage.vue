<template>
  <AppPage title="My courses" :on-refresh="load">
    <template v-if="isStaff">
      <p class="muted">
        Staff manage lectures and notes from Learning content; use Preview there to check playback.
      </p>
      <ion-button router-link="/lms/content">Open learning content</ion-button>
    </template>

    <template v-else-if="isParent">
      <div v-for="c in children" :key="c.student.id">
        <ion-list-header
          ><ion-label>{{ c.student.name }}</ion-label></ion-list-header
        >
        <CourseCard v-for="course in c.courses" :key="course.id" :course="course" :link="false" />
        <p v-if="!c.courses.length" class="muted ion-padding-horizontal">No courses yet.</p>
      </div>
      <p v-if="!loading && !children.length" class="muted">No linked students.</p>
    </template>

    <template v-else>
      <ion-button v-if="offline" fill="outline" size="small" router-link="/lms/offline"
        >Offline lectures</ion-button
      >
      <CourseCard v-for="course in courses" :key="course.id" :course="course" :link="true" />
      <p v-if="!loading && !courses.length" class="muted">
        You are not enrolled in any course with learning content yet.
      </p>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { IonButton, IonLabel, IonListHeader, onIonViewWillEnter } from '@ionic/vue';
import type { LmsLibraryCourseDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toastError } from '@/core/toast';
import { lmsApi, type ChildCourses } from './api';
import CourseCard from './CourseCard.vue';
import { offlineSupported, syncOffline } from './offline-store';
import { useLmsRole } from './roles';

const { isStaff, isParent } = useLmsRole();
const courses = ref<LmsLibraryCourseDto[]>([]);
const children = ref<ChildCourses[]>([]);
const loading = ref(true);
const offline = offlineSupported();

async function load() {
  if (isStaff.value) return;
  loading.value = true;
  try {
    if (isParent.value) children.value = await lmsApi.children();
    else {
      courses.value = await lmsApi.library();
      if (offline) syncOffline().catch(() => undefined);
    }
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}

onIonViewWillEnter(load);
</script>
