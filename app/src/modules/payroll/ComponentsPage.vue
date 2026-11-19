<template>
  <AppPage title="Statutory & custom components" :on-refresh="load">
    <template #actions>
      <ion-button v-can="'payroll.configure'" aria-label="New component" @click="edit()"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>
    <p class="muted">
      Defaults are editable starting points, not legal advice. Add a new version with a later “effective from”
      date when rates change; payroll uses the version effective for each month.
    </p>
    <ion-list>
      <ion-item v-for="c in components" :key="c.id" button @click="edit(c)">
        <ion-label class="ion-text-wrap">
          <h3>
            {{ c.name }} ({{ c.code }})
            <ion-badge v-if="c.statutory" color="tertiary">statutory</ion-badge>
            <ion-badge v-if="!c.active" color="medium">inactive</ion-badge>
          </h3>
          <p>{{ describe(c) }}</p>
          <p class="muted">
            From {{ c.effectiveFrom }}<span v-if="c.effectiveTo"> to {{ c.effectiveTo }}</span>
          </p>
        </ion-label>
      </ion-item>
    </ion-list>

    <ion-modal :is-open="!!form" @did-dismiss="form = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{ form?.id ? 'Edit component' : 'New component' }}</ion-title>
          <ion-buttons slot="end"><ion-button @click="form = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <form v-if="form" @submit.prevent="save">
          <ion-list>
            <ion-item
              ><ion-input v-model="form.code" label="Code" label-placement="stacked" required
            /></ion-item>
            <ion-item
              ><ion-input v-model="form.name" label="Name" label-placement="stacked" required
            /></ion-item>
            <ion-item>
              <ion-select v-model="form.kind" label="Kind" label-placement="stacked">
                <ion-select-option value="earning">Earning</ion-select-option>
                <ion-select-option value="deduction">Deduction</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-select v-model="form.calcType" label="Calculation" label-placement="stacked">
                <ion-select-option value="percent">Percentage</ion-select-option>
                <ion-select-option value="fixed">Fixed amount</ion-select-option>
                <ion-select-option value="slab">Slab on base</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-select v-model="form.base" label="Base" label-placement="stacked">
                <ion-select-option value="basic">Basic</ion-select-option>
                <ion-select-option value="gross">Gross</ion-select-option>
              </ion-select>
            </ion-item>
            <template v-if="form.calcType === 'percent'">
              <ion-item
                ><ion-input
                  v-model="form.employeeRate"
                  type="number"
                  label="Employee %"
                  label-placement="stacked"
              /></ion-item>
              <ion-item
                ><ion-input
                  v-model="form.employerRate"
                  type="number"
                  label="Employer %"
                  label-placement="stacked"
              /></ion-item>
              <ion-item
                ><ion-input
                  v-model="form.wageCeiling"
                  type="number"
                  label="Wage ceiling (₹, blank = none)"
                  label-placement="stacked"
              /></ion-item>
            </template>
            <ion-item v-if="form.calcType === 'fixed'">
              <ion-input
                v-model="form.fixedAmount"
                type="number"
                label="Amount (₹)"
                label-placement="stacked"
              />
            </ion-item>
            <template v-if="form.calcType === 'slab'">
              <ion-list-header>Slabs (base up to ₹ → amount ₹; blank “up to” = above)</ion-list-header>
              <ion-item v-for="(s, i) in form.slabs" :key="i">
                <ion-input v-model="s.upTo" type="number" placeholder="Up to ₹" />
                <ion-input v-model="s.amount" type="number" placeholder="Amount ₹" />
                <ion-button slot="end" fill="clear" color="danger" @click="form.slabs.splice(i, 1)"
                  >✕</ion-button
                >
              </ion-item>
              <ion-button fill="clear" size="small" @click="form.slabs.push({ upTo: '', amount: '' })"
                >Add slab</ion-button
              >
            </template>
            <ion-item>
              <ion-input
                v-model="form.eligibilityMaxGross"
                type="number"
                label="Applies only when gross ≤ ₹ (blank = always)"
                label-placement="stacked"
              />
            </ion-item>
            <ion-item
              ><ion-input
                v-model="form.effectiveFrom"
                type="date"
                label="Effective from"
                label-placement="stacked"
                required
            /></ion-item>
            <ion-item
              ><ion-input
                v-model="form.effectiveTo"
                type="date"
                label="Effective to"
                label-placement="stacked"
            /></ion-item>
            <ion-item><ion-checkbox v-model="form.active">Active</ion-checkbox></ion-item>
          </ion-list>
          <ion-button v-can="'payroll.configure'" expand="block" type="submit">Save</ion-button>
          <ion-button
            v-if="form.id"
            v-can="'payroll.configure'"
            expand="block"
            fill="clear"
            color="danger"
            @click="remove"
          >
            Delete
          </ion-button>
        </form>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  IonBadge,
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
import type { PayrollComponentDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { rupees, todayIso } from '../hr/api';
import { payrollApi } from './api';

type Str<T> = { [K in keyof T]: string };
type Form = Pick<
  PayrollComponentDto,
  'code' | 'name' | 'kind' | 'calcType' | 'base' | 'effectiveFrom' | 'active'
> &
  Str<
    Pick<
      PayrollComponentDto,
      'employeeRate' | 'employerRate' | 'fixedAmount' | 'wageCeiling' | 'eligibilityMaxGross' | 'effectiveTo'
    >
  > & {
    id?: number;
    slabs: { upTo: string; amount: string }[];
  };

const components = ref<PayrollComponentDto[]>([]);
const form = ref<Form | null>(null);
const str = (v: number | string | null | undefined, paise = false) =>
  v === null || v === undefined ? '' : String(paise ? Number(v) / 100 : v);
const num = (v: string, paise = false) => (v === '' ? null : paise ? Math.round(Number(v) * 100) : Number(v));

function describe(c: PayrollComponentDto) {
  const on = c.base === 'gross' ? 'gross' : 'basic';
  if (c.calcType === 'percent')
    return `${c.employeeRate ?? 0}% employee${c.employerRate ? ` + ${c.employerRate}% employer` : ''} of ${on}${
      c.wageCeiling ? ` (ceiling ${rupees(c.wageCeiling)})` : ''
    }${c.eligibilityMaxGross ? `, if gross ≤ ${rupees(c.eligibilityMaxGross)}` : ''}`;
  if (c.calcType === 'fixed') return `Fixed ${rupees(c.fixedAmount ?? 0)}`;
  return (c.slabs ?? [])
    .map((s) => `${s.upTo === null ? 'above' : `≤ ${rupees(s.upTo)}`}: ${rupees(s.amount)}`)
    .join(' · ');
}

async function load() {
  try {
    components.value = await payrollApi.components();
  } catch (e) {
    await toastError(e);
  }
}

function edit(c?: PayrollComponentDto) {
  form.value = {
    id: c?.id,
    code: c?.code ?? '',
    name: c?.name ?? '',
    kind: c?.kind ?? 'deduction',
    calcType: c?.calcType ?? 'percent',
    base: c?.base ?? 'basic',
    employeeRate: str(c?.employeeRate),
    employerRate: str(c?.employerRate),
    fixedAmount: str(c?.fixedAmount, true),
    wageCeiling: str(c?.wageCeiling, true),
    eligibilityMaxGross: str(c?.eligibilityMaxGross, true),
    slabs: (c?.slabs ?? []).map((s) => ({ upTo: str(s.upTo, true), amount: str(s.amount, true) })),
    effectiveFrom: c?.effectiveFrom ?? todayIso(),
    effectiveTo: c?.effectiveTo ?? '',
    active: c?.active ?? true,
  };
}

async function save() {
  const f = form.value!;
  try {
    await payrollApi.saveComponent(
      {
        code: f.code,
        name: f.name,
        kind: f.kind,
        calcType: f.calcType,
        base: f.base,
        employeeRate: num(f.employeeRate),
        employerRate: num(f.employerRate),
        fixedAmount: num(f.fixedAmount, true),
        wageCeiling: num(f.wageCeiling, true),
        eligibilityMaxGross: num(f.eligibilityMaxGross, true),
        slabs:
          f.calcType === 'slab'
            ? f.slabs.map((s) => ({ upTo: num(s.upTo, true), amount: num(s.amount, true) ?? 0 }))
            : null,
        effectiveFrom: f.effectiveFrom,
        effectiveTo: f.effectiveTo || null,
        active: f.active,
      },
      f.id,
    );
    form.value = null;
    await toast('Component saved');
    await load();
  } catch (e) {
    await toastError(e);
  }
}

async function remove() {
  if (!form.value?.id) return;
  await payrollApi
    .removeComponent(form.value.id)
    .then(() => (form.value = null))
    .then(load)
    .catch(toastError);
}

onMounted(load);
</script>
