<template>
  <AppPage title="HR settings" :on-refresh="load">
    <ion-segment v-model="tab">
      <ion-segment-button value="shifts">Shifts</ion-segment-button>
      <ion-segment-button value="leave">Leave types</ion-segment-button>
    </ion-segment>

    <template v-if="tab === 'shifts'">
      <ion-list>
        <ion-item v-for="s in shifts" :key="s.id" button @click="shiftForm = { ...s }">
          <ion-label>
            <h3>{{ s.name }}</h3>
            <p>{{ s.startTime }}–{{ s.endTime }} · grace {{ s.graceMinutes }} min</p>
          </ion-label>
          <ion-badge slot="end" :color="s.active ? 'success' : 'medium'">{{
            s.active ? 'active' : 'inactive'
          }}</ion-badge>
        </ion-item>
      </ion-list>
      <ion-button v-can="'hr.configure'" expand="block" fill="outline" @click="shiftForm = newShift()"
        >Add shift</ion-button
      >
      <form v-if="shiftForm" @submit.prevent="saveShift">
        <ion-list>
          <ion-item
            ><ion-input v-model="shiftForm.name" label="Name" label-placement="stacked" required
          /></ion-item>
          <ion-item
            ><ion-input v-model="shiftForm.startTime" type="time" label="Start" label-placement="stacked"
          /></ion-item>
          <ion-item
            ><ion-input v-model="shiftForm.endTime" type="time" label="End" label-placement="stacked"
          /></ion-item>
          <ion-item>
            <ion-input
              v-model.number="shiftForm.graceMinutes"
              type="number"
              label="Late after (grace minutes)"
              label-placement="stacked"
            />
          </ion-item>
          <ion-item><ion-checkbox v-model="shiftForm.active">Active</ion-checkbox></ion-item>
        </ion-list>
        <ion-button v-can="'hr.configure'" expand="block" type="submit">Save shift</ion-button>
      </form>
    </template>

    <template v-else>
      <ion-list>
        <ion-item v-for="t in leaveTypes" :key="t.id" button @click="typeForm = { ...t }">
          <ion-label>
            <h3>{{ t.name }} ({{ t.code }})</h3>
            <p>
              {{ t.annualQuota === null ? 'Unlimited' : `${t.annualQuota} days/year` }} ·
              {{ t.paid ? 'paid' : 'unpaid' }}{{ t.encashable ? ' · encashable' : '' }}
            </p>
          </ion-label>
          <ion-badge slot="end" :color="t.active ? 'success' : 'medium'">{{
            t.active ? 'active' : 'inactive'
          }}</ion-badge>
        </ion-item>
      </ion-list>
      <ion-button v-can="'hr.configure'" expand="block" fill="outline" @click="typeForm = newType()"
        >Add leave type</ion-button
      >
      <form v-if="typeForm" @submit.prevent="saveType">
        <ion-list>
          <ion-item
            ><ion-input v-model="typeForm.code" label="Code" label-placement="stacked" required
          /></ion-item>
          <ion-item
            ><ion-input v-model="typeForm.name" label="Name" label-placement="stacked" required
          /></ion-item>
          <ion-item>
            <ion-input
              v-model="quota"
              type="number"
              label="Annual quota (blank = unlimited)"
              label-placement="stacked"
            />
          </ion-item>
          <ion-item><ion-checkbox v-model="typeForm.paid">Paid</ion-checkbox></ion-item>
          <ion-item><ion-checkbox v-model="typeForm.encashable">Encashable at exit</ion-checkbox></ion-item>
          <ion-item><ion-checkbox v-model="typeForm.active">Active</ion-checkbox></ion-item>
        </ion-list>
        <ion-button v-can="'hr.configure'" expand="block" type="submit">Save leave type</ion-button>
      </form>
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
  IonSegment,
  IonSegmentButton,
} from '@ionic/vue';
import type { LeaveTypeDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { hrApi, type Shift } from './api';

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
  (t) => (quota.value = t?.annualQuota === null || t?.annualQuota === undefined ? '' : String(t.annualQuota)),
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
    await toast('Shift saved');
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
    await toast('Leave type saved');
    await load();
  } catch (e) {
    await toastError(e);
  }
}

onMounted(load);
</script>
