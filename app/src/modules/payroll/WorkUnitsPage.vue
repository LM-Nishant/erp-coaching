<template>
  <AppPage :title="t('payroll.workUnits.title')" :on-refresh="load">
    <i18n-t keypath="payroll.workUnits.intro" tag="p" class="muted">
      <template #api><code>POST /api/payroll/work-units/bulk</code></template>
      <template #field><code>externalRef</code></template>
    </i18n-t>
    <ion-item>
      <ion-input
        v-model="month"
        type="month"
        :label="t('payroll.month')"
        label-placement="stacked"
        @ion-change="load"
      />
    </ion-item>
    <ion-list>
      <ion-item v-for="u in units" :key="u.id">
        <ion-label>
          <h3>{{ u.employee?.name }} · {{ t(`payroll.unitType.${u.unitType}`) }}</h3>
          <p>
            {{ formatDate(u.date) }} ·
            {{
              u.unitType === 'incentive' ? formatMoney(u.amount) : t('payroll.workUnits.units', u.quantity)
            }}
            <span v-if="u.description"> · {{ u.description }}</span>
          </p>
        </ion-label>
        <StatusChip v-if="u.payrollRunId" slot="end" :label="t('common.status.paid')" tone="success" />
        <ion-button
          v-else
          slot="end"
          v-can="'payroll.delete'"
          fill="clear"
          color="danger"
          :aria-label="t('payroll.workUnits.delete')"
          @click="remove(u.id)"
        >
          <ion-icon slot="icon-only" :icon="trashOutline" />
        </ion-button>
      </ion-item>
      <ion-item v-if="!units.length"
        ><ion-label class="muted">{{ t('payroll.workUnits.empty') }}</ion-label></ion-item
      >
    </ion-list>

    <form v-can="'payroll.create'" @submit.prevent="save">
      <ion-list>
        <ion-list-header>{{ t('payroll.workUnits.addEntry') }}</ion-list-header>
        <ion-item>
          <ion-select v-model="form.employeeId" :label="t('payroll.employee')" label-placement="stacked">
            <ion-select-option v-for="e in employees" :key="e.id" :value="e.id">{{
              e.name
            }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item>
          <ion-select v-model="form.unitType" :label="t('payroll.workUnits.type')" label-placement="stacked">
            <ion-select-option value="lecture">{{ t('payroll.unitType.lecture') }}</ion-select-option>
            <ion-select-option value="class">{{ t('payroll.unitType.class') }}</ion-select-option>
            <ion-select-option value="incentive">{{ t('payroll.unitType.incentive') }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item
          ><ion-input
            v-model="form.date"
            type="date"
            :label="t('common.labels.date')"
            label-placement="stacked"
            required
        /></ion-item>
        <ion-item v-if="form.unitType === 'incentive'">
          <ion-input
            v-model="form.amount"
            type="number"
            :label="t('payroll.amountRupees')"
            label-placement="stacked"
            required
          />
        </ion-item>
        <ion-item v-else>
          <ion-input
            v-model="form.quantity"
            type="number"
            :label="t('payroll.workUnits.count')"
            label-placement="stacked"
            required
          />
        </ion-item>
        <ion-item
          ><ion-input
            v-model="form.description"
            :label="t('payroll.workUnits.description')"
            label-placement="stacked"
        /></ion-item>
      </ion-list>
      <ion-button expand="block" type="submit" :disabled="!form.employeeId">{{
        t('common.actions.add')
      }}</ion-button>
    </form>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
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
import StatusChip from '@/components/StatusChip.vue';
import { formatDate, formatMoney } from '@/core/format';
import { toast, toastError } from '@/core/toast';
import { hrApi, todayIso } from '../hr/api';
import { payrollApi, type WorkUnit } from './api';

const { t } = useI18n();
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
    await toast(t('common.saved'));
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
