<template>
  <AppPage :title="t('hr.settings.title')" :on-refresh="load">
    <ion-segment v-model="tab">
      <ion-segment-button value="shifts">{{ t('hr.settings.shifts') }}</ion-segment-button>
      <ion-segment-button value="leave">{{ t('hr.settings.leaveTypes') }}</ion-segment-button>
    </ion-segment>

    <template v-if="tab === 'shifts'">
      <ion-list>
        <ion-item v-for="s in shifts" :key="s.id" button @click="shiftForm = { ...s }">
          <ion-label>
            <h3>{{ s.name }}</h3>
            <p>
              {{ formatClock(s.startTime) }}–{{ formatClock(s.endTime) }} ·
              {{ t('hr.settings.grace', { n: s.graceMinutes }) }}
            </p>
          </ion-label>
          <StatusChip slot="end" :label="t(activeChip(s.active).label)" :tone="activeChip(s.active).tone" />
        </ion-item>
      </ion-list>
      <ion-button v-can="'hr.configure'" expand="block" fill="outline" @click="shiftForm = newShift()">{{
        t('hr.settings.addShift')
      }}</ion-button>
      <form v-if="shiftForm" @submit.prevent="saveShift">
        <ion-list>
          <ion-item
            ><ion-input
              v-model="shiftForm.name"
              :label="t('hr.fields.name')"
              label-placement="stacked"
              required
          /></ion-item>
          <ion-item
            ><ion-input
              v-model="shiftForm.startTime"
              type="time"
              :label="t('hr.settings.start')"
              label-placement="stacked"
          /></ion-item>
          <ion-item
            ><ion-input
              v-model="shiftForm.endTime"
              type="time"
              :label="t('hr.settings.end')"
              label-placement="stacked"
          /></ion-item>
          <ion-item>
            <ion-input
              v-model.number="shiftForm.graceMinutes"
              type="number"
              :label="t('hr.settings.graceLabel')"
              label-placement="stacked"
            />
          </ion-item>
          <ion-item
            ><ion-checkbox v-model="shiftForm.active">{{ t('common.status.active') }}</ion-checkbox></ion-item
          >
        </ion-list>
        <ion-button v-can="'hr.configure'" expand="block" type="submit">{{
          t('hr.settings.saveShift')
        }}</ion-button>
      </form>
    </template>

    <template v-else>
      <ion-list>
        <ion-item v-for="lt in leaveTypes" :key="lt.id" button @click="typeForm = { ...lt }">
          <ion-label>
            <h3>{{ lt.name }} ({{ lt.code }})</h3>
            <p>
              {{
                lt.annualQuota === null
                  ? t('hr.settings.unlimited')
                  : t('hr.settings.perYear', { n: formatNumber(lt.annualQuota) })
              }}
              · {{ lt.paid ? t('hr.settings.paid') : t('hr.settings.unpaid')
              }}{{ lt.encashable ? ` · ${t('hr.settings.encashable')}` : '' }}
            </p>
          </ion-label>
          <StatusChip slot="end" :label="t(activeChip(lt.active).label)" :tone="activeChip(lt.active).tone" />
        </ion-item>
      </ion-list>
      <ion-button v-can="'hr.configure'" expand="block" fill="outline" @click="typeForm = newType()">{{
        t('hr.settings.addLeaveType')
      }}</ion-button>
      <form v-if="typeForm" @submit.prevent="saveType">
        <ion-list>
          <ion-item
            ><ion-input
              v-model="typeForm.code"
              :label="t('hr.settings.code')"
              label-placement="stacked"
              required
          /></ion-item>
          <ion-item
            ><ion-input
              v-model="typeForm.name"
              :label="t('hr.fields.name')"
              label-placement="stacked"
              required
          /></ion-item>
          <ion-item>
            <ion-input
              v-model="quota"
              type="number"
              :label="t('hr.settings.quota')"
              label-placement="stacked"
            />
          </ion-item>
          <ion-item
            ><ion-checkbox v-model="typeForm.paid">{{ t('hr.settings.paidLabel') }}</ion-checkbox></ion-item
          >
          <ion-item
            ><ion-checkbox v-model="typeForm.encashable">{{
              t('hr.settings.encashableLabel')
            }}</ion-checkbox></ion-item
          >
          <ion-item
            ><ion-checkbox v-model="typeForm.active">{{ t('common.status.active') }}</ion-checkbox></ion-item
          >
        </ion-list>
        <ion-button v-can="'hr.configure'" expand="block" type="submit">{{
          t('hr.settings.saveLeaveType')
        }}</ion-button>
      </form>
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
  IonSegment,
  IonSegmentButton,
} from '@ionic/vue';
import type { LeaveTypeDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import StatusChip from '@/components/StatusChip.vue';
import { formatNumber } from '@/core/format';
import { toast, toastError } from '@/core/toast';
import { activeChip, formatClock, hrApi, type Shift } from './api';

const { t } = useI18n();

const tab = ref('shifts');
const shifts = ref<Shift[]>([]);
const leaveTypes = ref<LeaveTypeDto[]>([]);
const shiftForm = ref<Partial<Shift> | null>(null);
const typeForm = ref<Partial<LeaveTypeDto> | null>(null);
const quota = ref<string>('');

const newShift = (): Partial<Shift> => ({
  name: '',
  startTime: '09:00',
  endTime: '17:00',
  graceMinutes: 10,
  active: true,
});
const newType = (): Partial<LeaveTypeDto> => ({
  code: '',
  name: '',
  annualQuota: 12,
  paid: true,
  encashable: false,
  active: true,
});
watch(
  typeForm,
  (v) => (quota.value = v?.annualQuota === null || v?.annualQuota === undefined ? '' : String(v.annualQuota)),
);

async function load() {
  try {
    [shifts.value, leaveTypes.value] = await Promise.all([hrApi.shifts(), hrApi.leaveTypes()]);
  } catch (e) {
    await toastError(e);
  }
}

async function saveShift() {
  const { id, name, startTime, endTime, graceMinutes, active } = shiftForm.value!;
  try {
    await hrApi.saveShift({ name, startTime, endTime, graceMinutes: Number(graceMinutes), active }, id);
    shiftForm.value = null;
    await toast(t('hr.settings.shiftSaved'));
    await load();
  } catch (e) {
    await toastError(e);
  }
}

async function saveType() {
  const { id, code, name, paid, encashable, active } = typeForm.value!;
  try {
    await hrApi.saveLeaveType(
      { code, name, paid, encashable, active, annualQuota: quota.value === '' ? null : Number(quota.value) },
      id,
    );
    typeForm.value = null;
    await toast(t('hr.settings.leaveTypeSaved'));
    await load();
  } catch (e) {
    await toastError(e);
  }
}

onMounted(load);
</script>
