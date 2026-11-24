<template>
  <AppPage :title="t('lms.homework.title')" :on-refresh="load">
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
      <ion-segment-button value="pending"
        ><ion-label>{{ t('lms.homework.tabs.pending') }}</ion-label></ion-segment-button
      >
      <ion-segment-button value="done"
        ><ion-label>{{ t('lms.homework.tabs.done') }}</ion-label></ion-segment-button
      >
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
            <span v-if="a.subjectName"> · {{ a.subjectName }}</span> ·
            {{ t('lms.homework.dueAt', { date: formatDateTime(a.dueAt) }) }}
          </p>
          <p v-if="a.counts">
            {{ a.counts.submitted }}/{{ a.counts.students }} submitted · {{ a.counts.graded }} graded
          </p>
        </ion-label>
        <ion-badge v-if="isStaff" slot="end" :color="statusColor[a.status]">{{ a.status }}</ion-badge>
        <StatusChip v-else slot="end" :label="badge(a).text" :tone="badge(a).tone" />
      </ion-item>
    </ion-list>
    <EmptyState
      v-if="!loading && !items.length"
      :icon="checkmarkDoneOutline"
      :title="
        isStaff
          ? t('lms.homework.emptyStaff')
          : tab === 'pending'
            ? t('lms.homework.emptyPending')
            : t('lms.homework.emptyDone')
      "
    />
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
import { add, checkmarkDoneOutline } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import type { BatchDto, LmsAssignmentDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import EmptyState from '@/components/EmptyState.vue';
import StatusChip from '@/components/StatusChip.vue';
import { formatDateTime } from '@/core/format';
import { toastError } from '@/core/toast';
import { academicsApi } from '@/modules/academics/api';
import { lmsApi } from './api';
import { HOMEWORK_TONE, homeworkState } from './homework';
import { useLmsRole } from './roles';

const { isStaff, isParent } = useLmsRole();
const { t } = useI18n();
const statusColor: Record<string, string> = { draft: 'medium', published: 'primary', closed: 'dark' };
const items = ref<LmsAssignmentDto[]>([]);
const batches = ref<BatchDto[]>([]);
const batchId = ref<number | null>(null);
const tab = ref<'pending' | 'done'>('pending');
const loading = ref(true);

function badge(a: LmsAssignmentDto) {
  const state = homeworkState(a);
  const s = a.mySubmission;
  const text =
    state === 'graded' && s && a.maxMarks
      ? t('lms.homework.marks', { got: s.marks ?? '—', max: a.maxMarks })
      : state === 'submitted' && s?.isLate
        ? t('lms.homework.state.late')
        : t(`lms.homework.state.${state}`);
  return { text, tone: HOMEWORK_TONE[state] };
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
