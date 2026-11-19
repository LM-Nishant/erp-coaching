<template>
  <AppPage title="Homework" :on-refresh="load">
    <template #actions>
      <ion-button
        v-if="isStaff"
        v-can="'lms-assignments.edit'"
        router-link="/lms/homework/new"
        aria-label="New homework"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>

    <ion-item v-if="isStaff">
      <ion-select v-model="batchId" label="Batch" label-placement="stacked" interface="popover">
        <ion-select-option :value="null">All batches</ion-select-option>
        <ion-select-option v-for="b in batches" :key="b.id" :value="b.id">{{ b.name }}</ion-select-option>
      </ion-select>
    </ion-item>
    <ion-segment v-else v-model="tab">
      <ion-segment-button value="pending"><ion-label>To do</ion-label></ion-segment-button>
      <ion-segment-button value="done"><ion-label>Submitted</ion-label></ion-segment-button>
    </ion-segment>

    <ion-list>
      <ion-item
        v-for="a in items"
        :key="`${a.id}-${a.student?.id ?? ''}`"
        :router-link="`/lms/homework/${a.id}${a.student ? `?student=${a.student.id}` : ''}`"
        detail
      >
        <ion-label>
          <h2>{{ a.title }}</h2>
          <p>
            <span v-if="a.student">{{ a.student.name }} · </span>{{ a.batchName }}
            <span v-if="a.subjectName"> · {{ a.subjectName }}</span> · due {{ fmtDateTime(a.dueAt) }}
          </p>
          <p v-if="a.counts">
            {{ a.counts.submitted }}/{{ a.counts.students }} submitted · {{ a.counts.graded }} graded
          </p>
        </ion-label>
        <ion-badge v-if="isStaff" slot="end" :color="statusColor[a.status]">{{ a.status }}</ion-badge>
        <ion-badge v-else slot="end" :color="badge(a).color">{{ badge(a).text }}</ion-badge>
      </ion-item>
      <ion-item v-if="!loading && !items.length"
        ><ion-label class="muted">No homework here.</ion-label></ion-item
      >
    </ion-list>
  </AppPage>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  IonBadge,
  IonButton,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  onIonViewWillEnter,
} from '@ionic/vue';
import { add } from 'ionicons/icons';
import type { BatchDto, LmsAssignmentDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toastError } from '@/core/toast';
import { academicsApi } from '@/modules/academics/api';
import { fmtDateTime, lmsApi } from './api';
import { useLmsRole } from './roles';

const { isStaff, isParent } = useLmsRole();
const statusColor: Record<string, string> = { draft: 'medium', published: 'primary', closed: 'dark' };
const items = ref<LmsAssignmentDto[]>([]);
const batches = ref<BatchDto[]>([]);
const batchId = ref<number | null>(null);
const tab = ref<'pending' | 'done'>('pending');
const loading = ref(true);

function badge(a: LmsAssignmentDto) {
  const s = a.mySubmission;
  if (s?.status === 'graded')
    return { text: a.maxMarks ? `${s.marks ?? '—'}/${a.maxMarks}` : 'graded', color: 'success' };
  if (s?.status === 'returned') return { text: 'redo', color: 'warning' };
  if (s) return { text: s.isLate ? 'late' : 'submitted', color: 'primary' };
  return new Date(a.dueAt) < new Date()
    ? { text: 'overdue', color: 'danger' }
    : { text: 'pending', color: 'medium' };
}

async function load() {
  loading.value = true;
  try {
    if (isStaff.value) items.value = (await lmsApi.assignments({ batchId: batchId.value })).items;
    else if (isParent.value) items.value = await lmsApi.childrenAssignments({ status: tab.value });
    else items.value = (await lmsApi.assignments({ status: tab.value })).items;
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}

onIonViewWillEnter(async () => {
  if (isStaff.value && !batches.value.length)
    batches.value = (await academicsApi.batches().catch(() => ({ items: [] as BatchDto[] }))).items;
  await load();
});
watch([batchId, tab], load);
</script>
