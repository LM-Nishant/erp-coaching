<template>
  <AppPage title="Exam results" :on-refresh="load">
    <div v-if="loading && !items.length" class="ion-text-center ion-padding"><ion-spinner /></div>
    <ion-list>
      <ion-item
        v-for="it in items"
        :key="it.attemptId"
        button
        :detail="true"
        :router-link="`/exam-results/${it.attemptId}`"
      >
        <ion-label class="ion-text-wrap">
          <h2>{{ it.exam.title }}</h2>
          <p v-if="!isStudent && it.studentName">
            <strong>{{ it.studentName }}</strong>
          </p>
          <p>{{ formatDate(it.exam.startAt) }}</p>
          <p>
            Score {{ fmtMarks(it.totalScore) }} / {{ fmtMarks(it.maxScore) }} ({{ pct(it) }}%)
            <template v-if="it.rank"> · Rank {{ it.rank }}</template>
            <template v-if="it.percentile !== null"> · {{ fmtMarks(it.percentile) }} percentile</template>
          </p>
        </ion-label>
        <ion-badge v-if="passed(it) !== null" slot="end" :color="passed(it) ? 'success' : 'danger'">
          {{ passed(it) ? 'Passed' : 'Not passed' }}
        </ion-badge>
      </ion-item>
      <ion-item v-if="!loading && !items.length">
        <ion-label class="muted">No results have been published yet.</ion-label>
      </ion-item>
    </ion-list>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { IonBadge, IonItem, IonLabel, IonList, IonSpinner, onIonViewWillEnter } from '@ionic/vue';
import type { ChildResultListItem } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { examsApi, fmtMarks, formatDate } from './api';

const auth = useAuthStore();
const isStudent = computed(() => auth.can('exam-portal.create'));
const items = ref<ChildResultListItem[]>([]);
const loading = ref(true);

const pct = (it: ChildResultListItem) =>
  it.maxScore > 0 ? Math.round((Math.max(0, it.totalScore) / it.maxScore) * 1000) / 10 : 0;

const passed = (it: ChildResultListItem): boolean | null =>
  it.exam.passMarks === null ? null : it.totalScore >= it.exam.passMarks;

async function load() {
  loading.value = true;
  try {
    items.value = isStudent.value ? await examsApi.myResults() : await examsApi.childrenResults();
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}

onIonViewWillEnter(load);
</script>
