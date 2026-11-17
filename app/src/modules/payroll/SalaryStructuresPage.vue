<template>
  <AppPage title="Salary structures" :on-refresh="load">
    <template #actions>
      <ion-button v-can="'payroll.create'" @click="openEditor()"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>
    <ion-list>
      <ion-item v-for="s in structures" :key="s.id" button @click="openEditor(s)">
        <ion-label>
          <h3>{{ s.employee?.name }}</h3>
          <p>
            {{ PAY_TYPE_LABELS[s.payType] }} ·
            {{
              s.payType === 'fixed_monthly'
                ? `basic ${rupees(s.monthlyBasic)}`
                : `${rupees(s.ratePerUnit)} / unit`
            }}
            <span v-if="s.allowances?.length"> · {{ s.allowances.length }} allowance(s)</span>
          </p>
          <p class="muted">From {{ s.effectiveFrom }}</p>
        </ion-label>
      </ion-item>
      <ion-item v-if="!structures.length"
        ><ion-label class="muted">No salary structures yet.</ion-label></ion-item
      >
    </ion-list>

    <ion-modal :is-open="!!form" @did-dismiss="form = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>Salary structure</ion-title>
          <ion-buttons slot="end"><ion-button @click="form = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <form v-if="form" @submit.prevent="save">
          <p class="muted">
            Saving creates a new revision effective from the chosen date; the previous one is closed.
          </p>
          <ion-list>
            <ion-item>
              <ion-select v-model="form.employeeId" label="Employee" label-placement="stacked">
                <ion-select-option v-for="e in employees" :key="e.id" :value="e.id">{{
                  e.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-select v-model="form.payType" label="Pay type" label-placement="stacked">
                <ion-select-option v-for="t in PAY_TYPES" :key="t" :value="t">{{
                  PAY_TYPE_LABELS[t]
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item v-if="form.payType === 'fixed_monthly'">
              <ion-input
                v-model="form.basic"
                type="number"
                label="Monthly basic (₹)"
                label-placement="stacked"
              />
            </ion-item>
            <ion-item v-else>
              <ion-input
                v-model="form.rate"
                type="number"
                label="Rate per lecture / class (₹)"
                label-placement="stacked"
              />
            </ion-item>
            <ion-list-header>Monthly allowances</ion-list-header>
            <ion-item v-for="(a, i) in form.allowances" :key="i">
              <ion-input v-model="a.name" placeholder="Name (e.g. HRA)" />
              <ion-input v-model="a.amount" type="number" placeholder="₹" />
              <ion-button slot="end" fill="clear" color="danger" @click="form.allowances.splice(i, 1)"
                >✕</ion-button
              >
            </ion-item>
            <ion-button fill="clear" size="small" @click="form.allowances.push({ name: '', amount: '' })">
              Add allowance
            </ion-button>
            <ion-item><ion-checkbox v-model="form.pfApplicable">PF applicable</ion-checkbox></ion-item>
            <ion-item><ion-checkbox v-model="form.esiApplicable">ESI applicable</ion-checkbox></ion-item>
            <ion-item
              ><ion-checkbox v-model="form.ptApplicable">Professional tax applicable</ion-checkbox></ion-item
            >
            <ion-item><ion-checkbox v-model="form.tdsApplicable">TDS applicable</ion-checkbox></ion-item>
            <ion-item v-if="form.tdsApplicable">
              <ion-input
                v-model="form.tdsPercent"
                type="number"
                label="TDS % override (blank = component default)"
                label-placement="stacked"
              />
            </ion-item>
            <ion-item>
              <ion-input
                v-model="form.effectiveFrom"
                type="date"
                label="Effective from"
                label-placement="stacked"
                required
              />
            </ion-item>
          </ion-list>
          <ion-button v-can="'payroll.create'" expand="block" type="submit" :disabled="saving"
            >Save revision</ion-button
          >
        </form>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  IonButton,
  IonButtons,
  IonCheckbox,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonModal,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToolbar,
} from '@ionic/vue';
import { add } from 'ionicons/icons';
import { PAY_TYPES, type EmployeeDto, type PayType } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { hrApi, rupees, todayIso } from '../hr/api';
import { PAY_TYPE_LABELS, payrollApi, type SalaryStructure } from './api';

interface Form {
  employeeId: number | null;
  payType: PayType;
  basic: string;
  rate: string;
  allowances: { name: string; amount: string }[];
  pfApplicable: boolean;
  esiApplicable: boolean;
  ptApplicable: boolean;
  tdsApplicable: boolean;
  tdsPercent: string;
  effectiveFrom: string;
}

const structures = ref<SalaryStructure[]>([]);
const employees = ref<EmployeeDto[]>([]);
const form = ref<Form | null>(null);
const saving = ref(false);
const toRupees = (p: number) => String(p / 100);
const toPaise = (r: string) => Math.round(Number(r || 0) * 100);

async function load() {
  try {
    [structures.value, employees.value] = await Promise.all([
      payrollApi.structures(),
      hrApi.employees({ status: 'active', pageSize: 200 }).then((p) => p.items),
    ]);
  } catch (e) {
    await toastError(e);
  }
}

function openEditor(s?: SalaryStructure) {
  form.value = {
    employeeId: s?.employeeId ?? null,
    payType: s?.payType ?? 'fixed_monthly',
    basic: s ? toRupees(s.monthlyBasic) : '',
    rate: s ? toRupees(s.ratePerUnit) : '',
    allowances: (s?.allowances ?? []).map((a) => ({ name: a.name, amount: toRupees(a.amount) })),
    pfApplicable: s?.pfApplicable ?? true,
    esiApplicable: s?.esiApplicable ?? true,
    ptApplicable: s?.ptApplicable ?? true,
    tdsApplicable: s?.tdsApplicable ?? true,
    tdsPercent: s?.tdsPercent === null || s?.tdsPercent === undefined ? '' : String(s.tdsPercent),
    effectiveFrom: todayIso(),
  };
}

async function save() {
  const f = form.value;
  if (!f?.employeeId) return;
  saving.value = true;
  try {
    await payrollApi.createStructure({
      employeeId: f.employeeId,
      payType: f.payType,
      monthlyBasic: f.payType === 'fixed_monthly' ? toPaise(f.basic) : 0,
      ratePerUnit: f.payType === 'fixed_monthly' ? 0 : toPaise(f.rate),
      allowances: f.allowances
        .filter((a) => a.name)
        .map((a) => ({ name: a.name, amount: toPaise(a.amount) })),
      pfApplicable: f.pfApplicable,
      esiApplicable: f.esiApplicable,
      ptApplicable: f.ptApplicable,
      tdsApplicable: f.tdsApplicable,
      tdsPercent: f.tdsPercent === '' ? null : Number(f.tdsPercent),
      effectiveFrom: f.effectiveFrom,
    });
    form.value = null;
    await toast('Salary structure saved');
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>
