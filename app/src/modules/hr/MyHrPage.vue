<template>
  <AppPage title="My leave & attendance" :on-refresh="load">
    <ion-item v-if="error" lines="none"
      ><ion-label class="muted ion-text-wrap">{{ error }}</ion-label></ion-item
    >
    <template v-else>
      <ion-segment v-model="tab">
        <ion-segment-button value="leave">Leave</ion-segment-button>
        <ion-segment-button value="attendance">Attendance</ion-segment-button>
      </ion-segment>

      <template v-if="tab === 'leave'">
        <ion-list>
          <ion-list-header>Balances {{ new Date().getFullYear() }}</ion-list-header>
          <ion-item v-for="b in balances" :key="b.leaveTypeId">
            <ion-label>{{ b.name }}</ion-label>
            <ion-note slot="end">{{
              b.available === null ? `${b.used} used` : `${b.available} of ${b.quota} left`
            }}</ion-note>
          </ion-item>
        </ion-list>

        <form v-can="'hr-self-service.create'" @submit.prevent="apply">
          <ion-list>
            <ion-list-header>Apply for leave</ion-list-header>
            <ion-item>
              <ion-select v-model="form.leaveTypeId" label="Leave type" label-placement="stacked">
                <ion-select-option v-for="t in types" :key="t.id" :value="t.id">{{
                  t.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item
              ><ion-input v-model="form.fromDate" type="date" label="From" label-placement="stacked" required
            /></ion-item>
            <ion-item
              ><ion-input v-model="form.toDate" type="date" label="To" label-placement="stacked" required
            /></ion-item>
            <ion-item><ion-checkbox v-model="form.halfDay">Half day</ion-checkbox></ion-item>
            <ion-item
              ><ion-textarea v-model="form.reason" label="Reason" label-placement="stacked" auto-grow
            /></ion-item>
          </ion-list>
          <ion-button expand="block" type="submit" :disabled="saving || !form.leaveTypeId">Apply</ion-button>
        </form>

        <ion-list>
          <ion-list-header>My applications</ion-list-header>
          <ion-item v-for="l in leaves" :key="l.id">
            <ion-label class="ion-text-wrap">
              <h3>{{ l.leaveType?.name }} · {{ l.days }} day(s)</h3>
              <p>{{ l.fromDate }} → {{ l.toDate }}</p>
              <p v-if="l.decisionNote" class="muted">{{ l.decisionNote }}</p>
            </ion-label>
            <ion-badge slot="end" :color="COLORS[l.status]">{{ l.status }}</ion-badge>
            <ion-button
              v-if="l.status === 'pending'"
              slot="end"
              fill="clear"
              color="medium"
              @click="cancel(l.id)"
            >
              Cancel
            </ion-button>
          </ion-item>
          <ion-item v-if="!leaves.length"><ion-label class="muted">No applications yet.</ion-label></ion-item>
        </ion-list>
      </template>

      <template v-else>
        <ion-item>
          <ion-input
            v-model="month"
            type="month"
            label="Month"
            label-placement="stacked"
            @ion-change="loadAttendance"
          />
        </ion-item>
        <ion-list>
          <ion-item v-for="a in attendance" :key="a.id">
            <ion-label>
              <h3>{{ a.date }}</h3>
              <p>{{ [a.checkIn, a.checkOut].filter(Boolean).join(' – ') || a.source }}</p>
            </ion-label>
            <ion-badge slot="end">{{ a.status }}</ion-badge>
          </ion-item>
          <ion-item v-if="!attendance.length"
            ><ion-label class="muted">No attendance recorded.</ion-label></ion-item
          >
        </ion-list>
      </template>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import {
  IonBadge,
  IonButton,
  IonCheckbox,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonNote,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonTextarea,
} from '@ionic/vue';
import type {
  LeaveApplicationDto,
  LeaveBalanceDto,
  LeaveStatus,
  LeaveTypeDto,
  StaffAttendanceDto,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { ApiError } from '@/core/api';
import { toast, toastError } from '@/core/toast';
import { hrApi, todayIso } from './api';

const COLORS: Record<LeaveStatus, string> = {
  pending: 'warning',
  approved: 'success',
  rejected: 'danger',
  cancelled: 'medium',
};
const tab = ref('leave');
const error = ref('');
const balances = ref<LeaveBalanceDto[]>([]);
const types = ref<LeaveTypeDto[]>([]);
const leaves = ref<LeaveApplicationDto[]>([]);
const attendance = ref<StaffAttendanceDto[]>([]);
const month = ref(todayIso().slice(0, 7));
const saving = ref(false);
const blank = () => ({
  leaveTypeId: 0,
  fromDate: todayIso(),
  toDate: todayIso(),
  halfDay: false,
  reason: '',
});
const form = ref(blank());

async function load() {
  try {
    [balances.value, types.value, leaves.value] = await Promise.all([
      hrApi.myBalances(),
      hrApi.myLeaveTypes(),
      hrApi.myLeaves(),
    ]);
    error.value = '';
    if (tab.value === 'attendance') await loadAttendance();
  } catch (e) {
    if (e instanceof ApiError && e.status === 404)
      error.value = 'Your login is not linked to a staff profile yet. Contact HR.';
    else await toastError(e);
  }
}

async function loadAttendance() {
  const [y, m] = month.value.split('-').map(Number);
  attendance.value = await hrApi.myAttendance(y, m).catch(() => []);
}

async function apply() {
  saving.value = true;
  try {
    await hrApi.applyLeave({ ...form.value, reason: form.value.reason || undefined });
    form.value = blank();
    await toast('Leave applied');
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

async function cancel(id: number) {
  await hrApi.cancelMyLeave(id).then(load).catch(toastError);
}

onMounted(load);
watch(tab, (t) => t === 'attendance' && loadAttendance());
</script>
