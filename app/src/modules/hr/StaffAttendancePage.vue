<template>
  <AppPage :title="t('hr.attendance.title')" :on-refresh="load">
    <ion-segment v-model="view" @ion-change="load">
      <ion-segment-button value="day">{{ t('hr.attendance.daily') }}</ion-segment-button>
      <ion-segment-button value="month">{{ t('hr.attendance.monthly') }}</ion-segment-button>
    </ion-segment>

    <template v-if="view === 'day'">
      <ion-item>
        <ion-input
          v-model="date"
          type="date"
          :label="t('common.labels.date')"
          label-placement="stacked"
          @ion-change="load"
        />
      </ion-item>
      <ion-list>
        <ion-item v-for="e in employees" :key="e.id">
          <ion-label>
            <h3>{{ e.name }}</h3>
            <p>
              {{ e.employeeCode
              }}<span v-if="marks[e.id]?.source"> · {{ t(`hr.source.${marks[e.id].source}`) }}</span>
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
              t(ATTENDANCE_STATUS[s].label)
            }}</ion-select-option>
          </ion-select>
        </ion-item>
      </ion-list>
      <ion-button v-can="'hr.edit'" expand="block" :disabled="saving" @click="save">{{
        t('hr.attendance.save')
      }}</ion-button>
      <ion-button v-can="'hr.edit'" expand="block" fill="outline" @click="markAll('present')">
        {{ t('hr.attendance.markAll') }}
      </ion-button>
    </template>

    <template v-else>
      <ion-item>
        <ion-input
          v-model="month"
          type="month"
          :label="t('hr.month')"
          label-placement="stacked"
          @ion-change="load"
        />
      </ion-item>
      <ion-list>
        <ion-item v-for="r in summary" :key="r.employee.id">
          <ion-label>
            <h3>{{ r.employee.name }}</h3>
            <p>
              {{
                t('hr.attendance.summary', {
                  present: formatNumber(r.present),
                  absent: formatNumber(r.absent),
                  late: formatNumber(r.late),
                  leave: formatNumber(r.leave),
                  halfDay: formatNumber(r.half_day),
                })
              }}
            </p>
          </ion-label>
          <ion-note slot="end">{{ t('hr.attendance.lop', { n: formatNumber(r.lopDays) }) }}</ion-note>
        </ion-item>
      </ion-list>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
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
import { formatNumber } from '@/core/format';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { ATTENDANCE_STATUS, hrApi, todayIso, type AttendanceSummaryRow } from './api';

const { t } = useI18n();

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
    await toast(t('hr.attendance.saved'));
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>
