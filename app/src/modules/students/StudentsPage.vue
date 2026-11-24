<template>
  <AppPage title="Students" :on-refresh="load">
    <template #actions>
      <ion-button v-can="'students.configure'" router-link="/students/settings" aria-label="Student settings"
        ><ion-icon slot="icon-only" :icon="settingsOutline"
      /></ion-button>
      <ion-button v-can="'students.create'" aria-label="New student" @click="openCreate"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>

    <ion-searchbar
      v-model="search"
      :debounce="300"
      placeholder="Name, mobile, admission or roll no."
      @ion-input="reload"
    />
    <ion-segment v-model="status" scrollable @ion-change="reload">
      <ion-segment-button value="all"><ion-label>All</ion-label></ion-segment-button>
      <ion-segment-button v-for="s in STUDENT_STATUSES" :key="s" :value="s"
        ><ion-label>{{ humanize(s) }}</ion-label></ion-segment-button
      >
    </ion-segment>

    <ion-list>
      <ion-item v-for="s in students" :key="s.id" button :router-link="`/students/${s.id}`" detail>
        <ion-label>
          <h2>
            {{ s.name }} <ion-badge :color="STATUS_COLORS[s.status]">{{ s.status }}</ion-badge>
          </h2>
          <p>
            {{ s.admissionNumber }}<span v-if="s.rollNumber"> · Roll {{ s.rollNumber }}</span> ·
            {{ s.mobile }}
            <span v-if="branchName(s.branchId)"> · {{ branchName(s.branchId) }}</span>
          </p>
        </ion-label>
      </ion-item>
    </ion-list>
    <EmptyState
      v-if="!loading && !students.length"
      :icon="peopleOutline"
      :title="search || status !== 'all' ? t('students.list.noMatchTitle') : t('students.list.emptyTitle')"
      :message="search || status !== 'all' ? undefined : t('students.list.emptyMessage')"
    >
      <ion-button v-if="!search && status === 'all'" v-can="'students.create'" @click="openCreate">{{
        t('students.add.title')
      }}</ion-button>
    </EmptyState>
    <ion-infinite-scroll :disabled="students.length >= total" @ion-infinite="more">
      <ion-infinite-scroll-content />
    </ion-infinite-scroll>

    <AddStudentWizard :is-open="adding" :branches="branches" @close="adding = false" @added="load" />
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  IonBadge,
  IonButton,
  IonIcon,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonItem,
  IonLabel,
  IonList,
  IonSearchbar,
  IonSegment,
  IonSegmentButton,
  type InfiniteScrollCustomEvent,
} from '@ionic/vue';
import { add, peopleOutline, settingsOutline } from 'ionicons/icons';
import { STUDENT_STATUSES, type StudentDto, type StudentStatus } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import EmptyState from '@/components/EmptyState.vue';
import { toastError } from '@/core/toast';
import { branchesApi, type Branch } from '@/modules/branches/api';
import { useAuthStore } from '@/stores/auth';
import AddStudentWizard from './AddStudentWizard.vue';
import { STATUS_COLORS, humanize, studentsApi } from './api';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const { t } = useI18n();
const students = ref<StudentDto[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(true);
const search = ref('');
const status = ref<'all' | StudentStatus>('all');
const branches = ref<Branch[]>([]);
const adding = ref(false);

const branchName = (id: number) => branches.value.find((b) => b.id === id)?.name;

async function fetchPage() {
  const res = await studentsApi.list({
    page: page.value,
    search: search.value || undefined,
    status: status.value === 'all' ? undefined : status.value,
  });
  total.value = res.total;
  return res.items;
}

async function load() {
  loading.value = true;
  page.value = 1;
  try {
    students.value = await fetchPage();
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}
const reload = () => load();

async function more(ev: InfiniteScrollCustomEvent) {
  page.value++;
  try {
    students.value.push(...(await fetchPage()));
  } catch (e) {
    await toastError(e);
  } finally {
    await ev.target.complete();
  }
}

function openCreate() {
  adding.value = true;
}

onMounted(async () => {
  await load();
  branches.value = await branchesApi.list().catch(() => []);
});
watch(() => route.query.b, load);
watch(
  () => route.query.add,
  (v) => {
    if (v !== '1') return;
    adding.value = auth.can('students.create');
    void router.replace({ query: { ...route.query, add: undefined } });
  },
  { immediate: true },
);
</script>
