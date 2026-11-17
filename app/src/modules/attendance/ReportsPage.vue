<template>
  <AppPage title="Attendance reports" :on-refresh="load">
    <template #actions>
      <template v-if="auth.can('attendance.export')">
        <ion-button :disabled="busy" @click="download('csv')">CSV</ion-button>
        <ion-button :disabled="busy" @click="download('xls')">Excel</ion-button>
      </template>
    </template>

    <ion-segment v-model="kind">
      <ion-segment-button value="students">Students</ion-segment-button>
      <ion-segment-button value="batches">Batches</ion-segment-button>
      <ion-segment-button value="branches">Branches</ion-segment-button>
    </ion-segment>
    <ion-list>
      <ion-item>
        <ion-select v-model="period" label="Period" interface="popover" @ion-change="applyPeriod">
          <ion-select-option value="month">This month</ion-select-option>
          <ion-select-option value="last-month">Last month</ion-select-option>
          <ion-select-option value="year">This year</ion-select-option>
          <ion-select-option value="custom">Custom</ion-select-option>
        </ion-select>
      </ion-item>
      <template v-if="period === 'custom'">
        <ion-item
          ><ion-input v-model="filters.from" type="date" label="From" label-placement="stacked"
        /></ion-item>
        <ion-item
          ><ion-input v-model="filters.to" type="date" label="To" label-placement="stacked"
        /></ion-item>
      </template>
      <ion-item>
        <ion-select v-model="filters.batchId" label="Batch" interface="popover">
          <ion-select-option :value="null">All</ion-select-option>
          <ion-select-option v-for="b in batches" :key="b.id" :value="b.id">{{ b.name }}</ion-select-option>
        </ion-select>
      </ion-item>
      <ion-item v-if="branches.length > 1">
        <ion-select v-model="filters.branchId" label="Branch" interface="popover">
          <ion-select-option :value="null">All</ion-select-option>
          <ion-select-option v-for="b in branches" :key="b.id" :value="b.id">{{ b.name }}</ion-select-option>
        </ion-select>
      </ion-item>
    </ion-list>

    <ion-list v-if="kind === 'students'">
      <ion-item v-for="r in students" :key="r.studentUserId" button @click="openStudent(r.studentUserId)">
        <ion-label>
          {{ r.name }}
          <p>P {{ r.present }} · L {{ r.late }} · H {{ r.half_day }} · A {{ r.absent }} · LV {{ r.leave }}</p>
        </ion-label>
        <ion-badge slot="end" :color="r.belowThreshold ? 'danger' : 'success'">{{
          pct(r.percentage)
        }}</ion-badge>
      </ion-item>
    </ion-list>
    <ion-list v-else>
      <ion-item v-for="r in groups" :key="r.id">
        <ion-label>
          {{ r.name }}
          <p>{{ r.students }} students · P {{ r.present }} · A {{ r.absent }} · LV {{ r.leave }}</p>
        </ion-label>
        <ion-note slot="end">{{ pct(r.percentage) }}</ion-note>
      </ion-item>
    </ion-list>
    <p v-if="!rows.length" class="empty">No attendance recorded in this period.</p>

    <ion-modal :is-open="!!detail" @did-dismiss="detail = null">
      <ion-header
        ><ion-toolbar
          ><ion-title>{{ detail?.name }}</ion-title
          ><ion-buttons slot="end"
            ><ion-button @click="detail = null">Close</ion-button></ion-buttons
          ></ion-toolbar
        ></ion-header
      >
      <ion-content v-if="detail">
        <ion-list>
          <ion-item>
            <ion-label>Overall {{ detail.year }}</ion-label
            ><ion-note slot="end">{{ pct(detail.overall.percentage) }}</ion-note>
          </ion-item>
          <ion-item v-for="m in detail.months" :key="m.month">
            <ion-label
              >{{ m.month }}
              <p>P {{ m.present }} · A {{ m.absent }} · LV {{ m.leave }}</p></ion-label
            >
            <ion-note slot="end">{{ pct(m.percentage) }}</ion-note>
          </ion-item>
        </ion-list>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonNote,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToolbar,
} from '@ionic/vue';
import type {
  GroupAttendanceReportRow,
  StudentAttendanceReportRow,
  StudentAttendanceSummaryDto,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import {
  attendanceApi,
  downloadText,
  localDate,
  pct,
  type BranchRef,
  type ReportFilters,
  type ReportKind,
} from './api';

const auth = useAuthStore();
const kind = ref<ReportKind>('students');
const period = ref<'month' | 'last-month' | 'year' | 'custom'>('month');
const filters = reactive<ReportFilters>({ from: '', to: '', batchId: null, branchId: null });
const students = ref<StudentAttendanceReportRow[]>([]);
const groups = ref<GroupAttendanceReportRow[]>([]);
const batches = ref<{ id: number; name: string }[]>([]);
const branches = ref<BranchRef[]>([]);
const detail = ref<StudentAttendanceSummaryDto | null>(null);
const busy = ref(false);
const rows = computed(() => (kind.value === 'students' ? students.value : groups.value));

function applyPeriod() {
  const now = new Date();
  if (period.value === 'month') {
    filters.from = localDate(new Date(now.getFullYear(), now.getMonth(), 1));
    filters.to = localDate(now);
  } else if (period.value === 'last-month') {
    filters.from = localDate(new Date(now.getFullYear(), now.getMonth() - 1, 1));
    filters.to = localDate(new Date(now.getFullYear(), now.getMonth(), 0));
  } else if (period.value === 'year') {
    filters.from = `${now.getFullYear()}-01-01`;
    filters.to = localDate(now);
  }
}

async function load() {
  if (!filters.from || !filters.to) return;
  try {
    if (kind.value === 'students') students.value = await attendanceApi.studentReport({ ...filters });
    else groups.value = await attendanceApi.groupReport(kind.value, { ...filters });
  } catch (e) {
    await toastError(e);
  }
}

async function download(format: 'csv' | 'xls') {
  busy.value = true;
  try {
    const text = await attendanceApi.exportReport(kind.value, { ...filters }, format);
    downloadText(
      text,
      `attendance-${kind.value}-${filters.from}-${filters.to}.${format}`,
      format === 'csv' ? 'text/csv' : 'application/vnd.ms-excel',
    );
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

async function openStudent(id: number) {
  try {
    detail.value = await attendanceApi.studentSummary(id, Number(filters.from.slice(0, 4)));
  } catch (e) {
    await toastError(e);
  }
}

onMounted(async () => {
  applyPeriod();
  const [b, br] = await Promise.all([
    attendanceApi.batches().catch(() => ({ items: [] })),
    attendanceApi.branches().catch(() => []),
  ]);
  batches.value = b.items;
  branches.value = br;
  await load();
});
watch([kind, filters], load, { deep: true });
</script>

<style scoped>
.empty {
  padding: 16px;
  color: var(--ion-color-medium);
}
</style>
