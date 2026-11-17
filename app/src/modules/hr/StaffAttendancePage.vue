<template>
  <AppPage title="Staff attendance" :on-refresh="load">
    <ion-segment v-model="view" @ion-change="load">
      <ion-segment-button value="day">Daily register</ion-segment-button>
      <ion-segment-button value="month">Monthly summary</ion-segment-button>
    </ion-segment>

    <template v-if="view === 'day'">
      <ion-item>
        <ion-input v-model="date" type="date" label="Date" label-placement="stacked" @ion-change="load" />
      </ion-item>
      <ion-list>
        <ion-item v-for="e in employees" :key="e.id">
          <ion-label>
            <h3>{{ e.name }}</h3>
            <p>
              {{ e.employeeCode }}<span v-if="marks[e.id]?.source"> · {{ marks[e.id].source }}</span>
            </p>
          </ion-label>
          <ion-select
            slot="end"
            v-model="marks[e.id].status"
            interface="popover"
            placeholder="—"
            :disabled="!canEdit || marks[e.id].source === 'leave'"
          >
            <ion-select-option v-for="s in STAFF_ATTENDANCE_STATUSES" :key="s" :value="s">{{
              s
            }}</ion-select-option>
          </ion-select>
        </ion-item>
      </ion-list>
      <ion-button v-can="'hr.edit'" expand="block" :disabled="saving" @click="save"
        >Save attendance</ion-button
      >
      <ion-button v-can="'hr.edit'" expand="block" fill="outline" @click="markAll('present')">
        Mark unmarked as present
      </ion-button>
    </template>

    <template v-else>
      <ion-item>
        <ion-input v-model="month" type="month" label="Month" label-placement="stacked" @ion-change="load" />
      </ion-item>
      <ion-list>
        <ion-item v-for="r in summary" :key="r.employee.id">
          <ion-label>
            <h3>{{ r.employee.name }}</h3>
            <p>
              P {{ r.present }} · A {{ r.absent }} · Late {{ r.late }} · Leave {{ r.leave }} · Half
              {{ r.half_day }}
            </p>
          </ion-label>
          <ion-note slot="end">LOP {{ r.lopDays }}</ion-note>
        </ion-item>
      </ion-list>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  IonButton,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
} from '@ionic/vue';
import { STAFF_ATTENDANCE_STATUSES, type EmployeeDto, type StaffAttendanceStatus } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { hrApi, todayIso, type AttendanceSummaryRow } from './api';

const auth = useAuthStore();
const canEdit = computed(() => auth.can('hr.edit'));
const view = ref('day');
const date = ref(todayIso());
const month = ref(todayIso().slice(0, 7));
const employees = ref<EmployeeDto[]>([]);
const marks = ref<
  Record<number, { status: StaffAttendanceStatus | null; source: string | null; dirty?: boolean }>
>({});
const summary = ref<AttendanceSummaryRow[]>([]);
const saving = ref(false);

async function load() {
  try {
    if (view.value === 'day') {
      const [emps, rows] = await Promise.all([
        hrApi.employees({ status: 'active', pageSize: 200 }),
        hrApi.attendance(date.value, date.value),
      ]);
      employees.value = emps.items;
      marks.value = Object.fromEntries(emps.items.map((e) => [e.id, { status: null, source: null }]));
      for (const r of rows) marks.value[r.employeeId] = { status: r.status, source: r.source };
    } else {
      const [y, m] = month.value.split('-').map(Number);
      summary.value = await hrApi.attendanceSummary(y, m);
    }
  } catch (e) {
    await toastError(e);
  }
}

function markAll(status: StaffAttendanceStatus) {
  for (const m of Object.values(marks.value)) if (!m.status) m.status = status;
}

async function save() {
  const entries = Object.entries(marks.value)
    .filter(([, m]) => m.status && m.source !== 'leave')
    .map(([id, m]) => ({ employeeId: Number(id), date: date.value, status: m.status! }));
  if (!entries.length) return;
  saving.value = true;
  try {
    await hrApi.saveAttendance(entries);
    await toast('Attendance saved');
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>
