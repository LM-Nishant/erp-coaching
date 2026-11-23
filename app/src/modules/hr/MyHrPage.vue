<template>
  <AppPage :title="t('hr.my.title')" :on-refresh="load">
    <ion-item v-if="error" lines="none"
      ><ion-label class="muted ion-text-wrap">{{ error }}</ion-label></ion-item
    >
    <template v-else>
      <ion-segment v-model="tab">
        <ion-segment-button value="leave">{{ t('hr.my.tabLeave') }}</ion-segment-button>
        <ion-segment-button value="attendance">{{ t('hr.my.tabAttendance') }}</ion-segment-button>
      </ion-segment>

      <template v-if="tab === 'leave'">
        <ion-list>
          <ion-list-header>{{ t('hr.my.balances', { year: new Date().getFullYear() }) }}</ion-list-header>
          <ion-item v-for="b in balances" :key="b.leaveTypeId">
            <ion-label>{{ b.name }}</ion-label>
            <ion-note slot="end">{{
              b.available === null
                ? t('hr.my.used', { n: formatNumber(b.used) })
                : t('hr.my.left', { available: formatNumber(b.available), quota: formatNumber(b.quota) })
            }}</ion-note>
          </ion-item>
        </ion-list>

        <form v-can="'hr-self-service.create'" @submit.prevent="apply">
          <ion-list>
            <ion-list-header>{{ t('hr.my.applyTitle') }}</ion-list-header>
            <ion-item>
              <ion-select v-model="form.leaveTypeId" :label="t('hr.my.leaveType')" label-placement="stacked">
                <ion-select-option v-for="lt in types" :key="lt.id" :value="lt.id">{{
                  lt.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item
              ><ion-input
                v-model="form.fromDate"
                type="date"
                :label="t('common.labels.from')"
                label-placement="stacked"
                required
            /></ion-item>
            <ion-item
              ><ion-input
                v-model="form.toDate"
                type="date"
                :label="t('common.labels.to')"
                label-placement="stacked"
                required
            /></ion-item>
            <ion-item
              ><ion-checkbox v-model="form.halfDay">{{ t('hr.my.halfDay') }}</ion-checkbox></ion-item
            >
            <ion-item
              ><ion-textarea
                v-model="form.reason"
                :label="t('hr.reason')"
                label-placement="stacked"
                auto-grow
            /></ion-item>
          </ion-list>
          <ion-button expand="block" type="submit" :disabled="saving || !form.leaveTypeId">{{
            t('hr.my.apply')
          }}</ion-button>
        </form>

        <ion-list>
          <ion-list-header>{{ t('hr.my.applications') }}</ion-list-header>
          <ion-item v-for="l in leaves" :key="l.id">
            <ion-label class="ion-text-wrap">
              <h3>{{ l.leaveType?.name }} · {{ t('hr.days', l.days) }}</h3>
              <p>{{ formatDate(l.fromDate) }} → {{ formatDate(l.toDate) }}</p>
              <p v-if="l.decisionNote" class="muted">{{ l.decisionNote }}</p>
            </ion-label>
            <StatusChip
              slot="end"
              :label="t(LEAVE_STATUS[l.status].label)"
              :tone="LEAVE_STATUS[l.status].tone"
            />
            <ion-button
              v-if="l.status === 'pending'"
              slot="end"
              fill="clear"
              color="medium"
              @click="cancel(l.id)"
            >
              {{ t('common.actions.cancel') }}
            </ion-button>
          </ion-item>
          <ion-item v-if="!leaves.length"
            ><ion-label class="muted">{{ t('hr.my.noApplications') }}</ion-label></ion-item
          >
        </ion-list>
      </template>

      <template v-else>
        <ion-item>
          <ion-input
            v-model="month"
            type="month"
            :label="t('hr.month')"
            label-placement="stacked"
            @ion-change="loadAttendance"
          />
        </ion-item>
        <ion-list>
          <ion-item v-for="a in attendance" :key="a.id">
            <ion-label>
              <h3>{{ formatDayShort(a.date) }}</h3>
              <p>
                {{
                  [a.checkIn, a.checkOut]
                    .filter(Boolean)
                    .map((x) => formatClock(x))
                    .join(' – ') || t(`hr.source.${a.source}`)
                }}
              </p>
            </ion-label>
            <StatusChip
              slot="end"
              :label="t(ATTENDANCE_STATUS[a.status].label)"
              :tone="ATTENDANCE_STATUS[a.status].tone"
            />
          </ion-item>
          <ion-item v-if="!attendance.length"
            ><ion-label class="muted">{{ t('hr.my.noAttendance') }}</ion-label></ion-item
          >
        </ion-list>
      </template>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
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
import type { LeaveApplicationDto, LeaveBalanceDto, LeaveTypeDto, StaffAttendanceDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import StatusChip from '@/components/StatusChip.vue';
import { ApiError } from '@/core/api';
import { formatDate, formatDayShort, formatNumber } from '@/core/format';
import { toast, toastError } from '@/core/toast';
import { ATTENDANCE_STATUS, LEAVE_STATUS, formatClock, hrApi, todayIso } from './api';

const { t } = useI18n();
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
    if (e instanceof ApiError && e.status === 404) error.value = t('hr.notLinked');
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
    await toast(t('hr.my.applied'));
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
watch(tab, (v) => v === 'attendance' && loadAttendance());
</script>
