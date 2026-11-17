<template>
  <AppPage title="Lectures & incentives" :on-refresh="load">
    <p class="muted">
      Lectures/classes taken by per-lecture or per-class staff, and incentives. Other modules (timetable,
      batches) can post these via <code>POST /api/payroll/work-units/bulk</code> with an
      <code>externalRef</code> for idempotency.
    </p>
    <ion-item>
      <ion-input v-model="month" type="month" label="Month" label-placement="stacked" @ion-change="load" />
    </ion-item>
    <ion-list>
      <ion-item v-for="u in units" :key="u.id">
        <ion-label>
          <h3>{{ u.employee?.name }} · {{ u.unitType }}</h3>
          <p>
            {{ u.date }} · {{ u.unitType === 'incentive' ? rupees(u.amount) : `${u.quantity} unit(s)` }}
            <span v-if="u.description"> · {{ u.description }}</span>
          </p>
        </ion-label>
        <ion-badge v-if="u.payrollRunId" slot="end" color="success">paid</ion-badge>
        <ion-button
          v-else
          slot="end"
          v-can="'payroll.delete'"
          fill="clear"
          color="danger"
          @click="remove(u.id)"
        >
          <ion-icon slot="icon-only" :icon="trashOutline" />
        </ion-button>
      </ion-item>
      <ion-item v-if="!units.length"
        ><ion-label class="muted">Nothing recorded for this month.</ion-label></ion-item
      >
    </ion-list>

    <form v-can="'payroll.create'" @submit.prevent="save">
      <ion-list>
        <ion-list-header>Add entry</ion-list-header>
        <ion-item>
          <ion-select v-model="form.employeeId" label="Employee" label-placement="stacked">
            <ion-select-option v-for="e in employees" :key="e.id" :value="e.id">{{
              e.name
            }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item>
          <ion-select v-model="form.unitType" label="Type" label-placement="stacked">
            <ion-select-option value="lecture">Lecture</ion-select-option>
            <ion-select-option value="class">Class</ion-select-option>
            <ion-select-option value="incentive">Incentive</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item
          ><ion-input v-model="form.date" type="date" label="Date" label-placement="stacked" required
        /></ion-item>
        <ion-item v-if="form.unitType === 'incentive'">
          <ion-input
            v-model="form.amount"
            type="number"
            label="Amount (₹)"
            label-placement="stacked"
            required
          />
        </ion-item>
        <ion-item v-else>
          <ion-input v-model="form.quantity" type="number" label="Count" label-placement="stacked" required />
        </ion-item>
        <ion-item
          ><ion-input v-model="form.description" label="Description" label-placement="stacked"
        /></ion-item>
      </ion-list>
      <ion-button expand="block" type="submit" :disabled="!form.employeeId">Add</ion-button>
    </form>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  IonBadge,
  IonButton,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonSelect,
  IonSelectOption,
} from '@ionic/vue';
import { trashOutline } from 'ionicons/icons';
import type { EmployeeDto, WorkUnitType } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { hrApi, rupees, todayIso } from '../hr/api';
import { payrollApi, type WorkUnit } from './api';

const month = ref(todayIso().slice(0, 7));
const units = ref<WorkUnit[]>([]);
const employees = ref<EmployeeDto[]>([]);
const blank = () => ({
  employeeId: null as number | null,
  unitType: 'lecture' as WorkUnitType,
  date: todayIso(),
  quantity: '1',
  amount: '',
  description: '',
});
const form = ref(blank());

async function load() {
  const [y, m] = month.value.split('-').map(Number);
  try {
    [units.value, employees.value] = await Promise.all([
      payrollApi.workUnits(y, m),
      hrApi.employees({ status: 'active', pageSize: 200 }).then((p) => p.items),
    ]);
  } catch (e) {
    await toastError(e);
  }
}

async function save() {
  const f = form.value;
  try {
    await payrollApi.addWorkUnit({
      employeeId: f.employeeId!,
      unitType: f.unitType,
      date: f.date,
      ...(f.unitType === 'incentive'
        ? { amount: Math.round(Number(f.amount) * 100) }
        : { quantity: Number(f.quantity) }),
      description: f.description || null,
    });
    form.value = { ...blank(), employeeId: f.employeeId, unitType: f.unitType };
    await toast('Saved');
    await load();
  } catch (e) {
    await toastError(e);
  }
}

async function remove(id: number) {
  await payrollApi.removeWorkUnit(id).then(load).catch(toastError);
}

onMounted(load);
</script>
