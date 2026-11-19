<template>
  <AppPage title="Learning content" :on-refresh="load">
    <template #actions>
      <ion-button v-can="'lms.create'" router-link="/lms/content/new" aria-label="New content"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>

    <ion-list>
      <ion-item>
        <ion-select v-model="filters.courseId" label="Course" label-placement="stacked" interface="popover">
          <ion-select-option :value="null">All courses</ion-select-option>
          <ion-select-option v-for="c in courses" :key="c.id" :value="c.id">{{ c.name }}</ion-select-option>
        </ion-select>
      </ion-item>
      <ion-item>
        <ion-select v-model="filters.type" label="Type" label-placement="stacked" interface="popover">
          <ion-select-option value="">All types</ion-select-option>
          <ion-select-option v-for="t in LMS_RESOURCE_TYPES" :key="t" :value="t">{{
            RESOURCE_TYPE_LABEL[t]
          }}</ion-select-option>
        </ion-select>
        <ion-select v-model="filters.status" label="Status" label-placement="stacked" interface="popover">
          <ion-select-option value="">Any status</ion-select-option>
          <ion-select-option v-for="s in LMS_RESOURCE_STATUSES" :key="s" :value="s">{{
            s
          }}</ion-select-option>
        </ion-select>
      </ion-item>
    </ion-list>

    <ion-list>
      <ion-item v-for="r in items" :key="r.id" :router-link="`/lms/content/${r.id}`" detail>
        <ion-label>
          <h2>{{ r.title }}</h2>
          <p>
            {{ RESOURCE_TYPE_LABEL[r.type] }} · {{ r.courseName }}
            <span v-if="r.durationSeconds"> · {{ formatDuration(r.durationSeconds) }}</span>
            <span v-if="r.type === 'video'">
              · stream: {{ r.transcodeStatus === 'ready' ? 'HLS' : 'MP4' }}</span
            >
          </p>
        </ion-label>
        <ion-badge slot="end" :color="r.access === 'free' ? 'success' : 'tertiary'">{{ r.access }}</ion-badge>
        <ion-badge slot="end" :color="statusColor[r.status]">{{ r.status }}</ion-badge>
      </ion-item>
      <ion-item v-if="!loading && !items.length">
        <ion-label class="muted">No learning resources yet. Tap + to upload a lecture or notes.</ion-label>
      </ion-item>
    </ion-list>
  </AppPage>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import {
  IonBadge,
  IonButton,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonSelect,
  IonSelectOption,
  onIonViewWillEnter,
} from '@ionic/vue';
import { add } from 'ionicons/icons';
import { LMS_RESOURCE_STATUSES, LMS_RESOURCE_TYPES, type CourseDto, type LmsResourceDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toastError } from '@/core/toast';
import { academicsApi } from '@/modules/academics/api';
import { RESOURCE_TYPE_LABEL, formatDuration, lmsApi } from './api';

const statusColor: Record<string, string> = { draft: 'medium', published: 'primary', archived: 'dark' };
const filters = reactive({ courseId: null as number | null, type: '', status: '' });
const courses = ref<CourseDto[]>([]);
const items = ref<LmsResourceDto[]>([]);
const loading = ref(true);

async function load() {
  loading.value = true;
  try {
    items.value = (await lmsApi.resources({ ...filters })).items;
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}

onIonViewWillEnter(async () => {
  academicsApi
    .courses()
    .then((p) => (courses.value = p.items))
    .catch(() => undefined);
  await load();
});
watch(filters, load);
</script>
