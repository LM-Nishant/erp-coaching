<template>
  <AppPage title="My attendance" :on-refresh="load">
    <ion-segment v-model="tab">
      <ion-segment-button value="summary">Summary</ion-segment-button>
      <ion-segment-button value="requests">Requests</ion-segment-button>
    </ion-segment>

    <ion-list>
      <ion-item v-if="children.length">
        <ion-select v-model="childId" label="Student" interface="popover" @ion-change="load">
          <ion-select-option v-for="c in children" :key="c.studentUserId" :value="c.studentUserId">{{
            c.name
          }}</ion-select-option>
        </ion-select>
      </ion-item>
      <ion-item v-if="tab === 'summary'">
        <ion-select v-model="year" label="Year" interface="popover" @ion-change="load">
          <ion-select-option v-for="y in years" :key="y" :value="y">{{ y }}</ion-select-option>
        </ion-select>
      </ion-item>
    </ion-list>

    <template v-if="tab === 'summary' && summary">
      <div class="stats">
        <StatCard label="Attendance" :value="pct(summary.overall.percentage)" />
        <StatCard label="Present" :value="summary.overall.present + summary.overall.late" />
        <StatCard label="Absent" :value="summary.overall.absent" />
        <StatCard label="Leave" :value="summary.overall.leave" />
      </div>
      <ion-list>
        <ion-list-header><ion-label>By month</ion-label></ion-list-header>
        <ion-item v-for="m in summary.months" :key="m.month">
          <ion-label>
            {{ monthName(m.month) }}
            <p>
              P {{ m.present }} · L {{ m.late }} · H {{ m.half_day }} · A {{ m.absent }} · LV {{ m.leave }}
            </p>
          </ion-label>
          <ion-note slot="end">{{ pct(m.percentage) }}</ion-note>
        </ion-item>
        <ion-list-header><ion-label>Recent sessions</ion-label></ion-list-header>
        <ion-item v-for="r in summary.records.slice(0, 60)" :key="r.attendanceSessionId">
          <ion-label>
            {{ r.date }} · {{ r.batchName }}<span v-if="r.subjectName"> · {{ r.subjectName }}</span>
            <p v-if="r.startTime">{{ r.startTime.slice(0, 5) }} · via {{ r.source }}</p>
          </ion-label>
          <ion-badge slot="end" :color="STATUS_COLOR[r.status]">{{ STATUS_LABEL[r.status] }}</ion-badge>
          <ion-button
            slot="end"
            fill="clear"
            size="small"
            @click="startCorrection(r.attendanceSessionId, r.status)"
            >Fix</ion-button
          >
        </ion-item>
      </ion-list>
    </template>

    <template v-if="tab === 'requests'">
      <ion-list>
        <ion-list-header>
          <ion-label>Leave requests</ion-label>
          <ion-button @click="leaveForm = !leaveForm">{{ leaveForm ? 'Cancel' : 'Apply' }}</ion-button>
        </ion-list-header>
        <template v-if="leaveForm">
          <ion-item
            ><ion-input v-model="leave.fromDate" type="date" label="From" label-placement="stacked"
          /></ion-item>
          <ion-item
            ><ion-input v-model="leave.toDate" type="date" label="To" label-placement="stacked"
          /></ion-item>
          <ion-item
            ><ion-textarea v-model="leave.reason" label="Reason" label-placement="stacked" auto-grow
          /></ion-item>
          <ion-button expand="block" class="pad" :disabled="busy" @click="applyLeave"
            >Submit leave request</ion-button
          >
        </template>
        <ion-item v-for="l in leaves" :key="`l${l.id}`">
          <ion-label>
            {{ l.fromDate }}<span v-if="l.toDate !== l.fromDate"> → {{ l.toDate }}</span>
            <span v-if="l.studentName"> · {{ l.studentName }}</span>
            <p>{{ l.reason }}</p>
            <p v-if="l.decisionNote">Note: {{ l.decisionNote }}</p>
          </ion-label>
          <ion-badge slot="end" :color="REQ_COLOR[l.status]">{{ l.status }}</ion-badge>
          <ion-button
            v-if="l.status === 'pending'"
            slot="end"
            fill="clear"
            size="small"
            @click="cancelLeave(l.id)"
            >Cancel</ion-button
          >
        </ion-item>

        <ion-list-header><ion-label>Correction requests</ion-label></ion-list-header>
        <ion-item v-for="c in corrections" :key="`c${c.id}`">
          <ion-label>
            {{ c.date }} · {{ c.batchName }}<span v-if="c.studentName"> · {{ c.studentName }}</span>
            <p>
              {{ c.currentStatus ? STATUS_LABEL[c.currentStatus] : 'Unmarked' }} →
              {{ STATUS_LABEL[c.requestedStatus] }}: {{ c.reason }}
            </p>
            <p v-if="c.decisionNote">Note: {{ c.decisionNote }}</p>
          </ion-label>
          <ion-badge slot="end" :color="REQ_COLOR[c.status]">{{ c.status }}</ion-badge>
          <ion-button
            v-if="c.status === 'pending'"
            slot="end"
            fill="clear"
            size="small"
            @click="cancelCorrection(c.id)"
            >Cancel</ion-button
          >
        </ion-item>
      </ion-list>
    </template>

    <ion-modal :is-open="!!fix" @did-dismiss="fix = null">
      <ion-header
        ><ion-toolbar
          ><ion-title>Request correction</ion-title
          ><ion-buttons slot="end"
            ><ion-button @click="fix = null">Close</ion-button></ion-buttons
          ></ion-toolbar
        ></ion-header
      >
      <ion-content v-if="fix" class="ion-padding">
        <ion-item>
          <ion-select v-model="fix.requestedStatus" label="Should be" interface="popover">
            <ion-select-option v-for="s in ATTENDANCE_STATUSES" :key="s" :value="s">{{
              STATUS_LABEL[s]
            }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item
          ><ion-textarea v-model="fix.reason" label="Reason" label-placement="stacked" auto-grow
        /></ion-item>
        <ion-button expand="block" class="pad" :disabled="busy" @click="submitCorrection">Submit</ion-button>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue';
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
  IonListHeader,
  IonModal,
  IonNote,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonTextarea,
  IonTitle,
  IonToolbar,
} from '@ionic/vue';
import {
  ATTENDANCE_STATUSES,
  type AttendanceCorrectionDto,
  type AttendanceStatus,
  type StudentAttendanceSummaryDto,
  type StudentLeaveRequestDto,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import StatCard from '@/components/StatCard.vue';
import { toast, toastError } from '@/core/toast';
import { STATUS_COLOR, STATUS_LABEL, attendanceApi, localDate, pct } from './api';

const REQ_COLOR: Record<string, string> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  cancelled: 'medium',
};

const tab = ref<'summary' | 'requests'>('summary');
const year = ref(new Date().getFullYear());
const years = [year.value, year.value - 1, year.value - 2];
const children = ref<{ studentUserId: number; name: string }[]>([]);
const childId = ref<number | null>(null);
const summary = ref<StudentAttendanceSummaryDto | null>(null);
const leaves = ref<StudentLeaveRequestDto[]>([]);
const corrections = ref<AttendanceCorrectionDto[]>([]);
const busy = ref(false);
const leaveForm = ref(false);
const leave = reactive({ fromDate: localDate(), toDate: localDate(), reason: '' });
const fix = ref<{ attendanceSessionId: number; requestedStatus: AttendanceStatus; reason: string } | null>(
  null,
);

const monthName = (m: string) =>
  new Date(`${m}-01T00:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
/** Parents act on behalf of the selected child; students on themselves. */
const forWhom = () => (childId.value ? { studentUserId: childId.value } : {});
const mine = <T extends { studentUserId: number }>(rows: T[]) =>
  childId.value ? rows.filter((r) => r.studentUserId === childId.value) : rows;

async function load() {
  try {
    if (tab.value === 'summary') {
      if (children.value.length && !childId.value) return;
      summary.value = childId.value
        ? await attendanceApi.childSummary(childId.value, year.value)
        : await attendanceApi.mySummary(year.value);
    } else {
      const [l, c] = await Promise.all([attendanceApi.myLeaves(), attendanceApi.myCorrections()]);
      leaves.value = mine(l);
      corrections.value = mine(c);
    }
  } catch (e) {
    await toastError(e);
  }
}

function startCorrection(attendanceSessionId: number, status: AttendanceStatus) {
  fix.value = { attendanceSessionId, requestedStatus: status === 'absent' ? 'present' : status, reason: '' };
}

async function submitCorrection() {
  if (!fix.value) return;
  busy.value = true;
  try {
    const c = await attendanceApi.requestCorrection({ ...fix.value, ...forWhom() });
    fix.value = null;
    await toast(c.status === 'approved' ? 'Corrected' : 'Correction requested');
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

async function applyLeave() {
  busy.value = true;
  try {
    await attendanceApi.requestLeave({ ...leave, ...forWhom() });
    leaveForm.value = false;
    leave.reason = '';
    await toast('Leave requested');
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

async function cancelLeave(id: number) {
  await attendanceApi.cancelLeave(id).then(load, toastError);
}
async function cancelCorrection(id: number) {
  await attendanceApi.cancelCorrection(id).then(load, toastError);
}

onMounted(async () => {
  children.value = await attendanceApi.children().catch(() => []);
  childId.value = children.value[0]?.studentUserId ?? null;
  await load();
});
watch(tab, load);
</script>

<style scoped>
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 8px;
  padding: 8px;
}
.pad {
  margin: 12px 16px;
}
</style>
