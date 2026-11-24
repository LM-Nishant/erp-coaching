<template>
  <AppPage :title="t('lms.library.title')" :on-refresh="load">
    <template v-if="isStaff">
      <p class="muted">{{ t('lms.library.staffHint') }}</p>
      <ion-button router-link="/lms/content">{{ t('lms.library.openContent') }}</ion-button>
    </template>

    <template v-else-if="isParent">
      <div v-for="c in children" :key="c.student.id">
        <ion-list-header
          ><ion-label>{{ c.student.name }}</ion-label></ion-list-header
        >
        <CourseCard v-for="course in c.courses" :key="course.id" :course="course" :link="false" />
        <p v-if="!c.courses.length" class="muted ion-padding-horizontal">{{ t('lms.library.noCourses') }}</p>
      </div>
      <p v-if="!loading && !children.length" class="muted">{{ t('lms.library.noChildren') }}</p>
    </template>

    <template v-else>
      <ion-button v-if="offline" fill="outline" size="small" router-link="/lms/offline">{{
        t('lms.offline.title')
      }}</ion-button>
      <CourseCard v-for="course in courses" :key="course.id" :course="course" :link="true" />
      <p v-if="!loading && !courses.length" class="muted">{{ t('lms.library.notEnrolled') }}</p>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { IonButton, IonLabel, IonListHeader, onIonViewWillEnter } from '@ionic/vue';
import type { LmsLibraryCourseDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toastError } from '@/core/toast';
import { lmsApi, type ChildCourses } from './api';
import CourseCard from './CourseCard.vue';
import { offlineSupported, syncOffline } from './offline-store';
import { useLmsRole } from './roles';

const { t } = useI18n();
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
