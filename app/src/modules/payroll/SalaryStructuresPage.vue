<template>
  <AppPage :title="t('payroll.structures.title')" :on-refresh="load">
    <template #actions>
      <ion-button v-can="'payroll.create'" :aria-label="t('payroll.structures.new')" @click="openEditor()"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>
    <ion-list>
      <ion-item v-for="s in structures" :key="s.id" button @click="openEditor(s)">
        <ion-label>
          <h3>{{ s.employee?.name }}</h3>
          <p>
            {{ t(`payroll.payType.${s.payType}`) }} ·
            {{
              s.payType === 'fixed_monthly'
                ? t('payroll.structures.basic', { amount: formatMoney(s.monthlyBasic) })
                : t('payroll.structures.perUnit', { amount: formatMoney(s.ratePerUnit) })
            }}
            <span v-if="s.allowances?.length">
              · {{ t('payroll.structures.allowanceCount', s.allowances.length) }}</span
            >
          </p>
          <p class="muted">{{ t('payroll.fromDate', { date: formatDate(s.effectiveFrom) }) }}</p>
        </ion-label>
      </ion-item>
      <ion-item v-if="!structures.length"
        ><ion-label class="muted">{{ t('payroll.structures.empty') }}</ion-label></ion-item
      >
    </ion-list>

    <ion-modal :is-open="!!form" @did-dismiss="form = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{ t('payroll.structures.modalTitle') }}</ion-title>
          <ion-buttons slot="end"
            ><ion-button @click="form = null">{{ t('common.actions.close') }}</ion-button></ion-buttons
          >
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <form v-if="form" @submit.prevent="save">
          <p class="muted">{{ t('payroll.structures.note') }}</p>
          <ion-list>
            <ion-item>
              <ion-select v-model="form.employeeId" :label="t('payroll.employee')" label-placement="stacked">
                <ion-select-option v-for="e in employees" :key="e.id" :value="e.id">{{
                  e.name
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-select
                v-model="form.payType"
                :label="t('payroll.structures.payType')"
                label-placement="stacked"
              >
                <ion-select-option v-for="pt in PAY_TYPES" :key="pt" :value="pt">{{
                  t(`payroll.payType.${pt}`)
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item v-if="form.payType === 'fixed_monthly'">
              <ion-input
                v-model="form.basic"
                type="number"
                :label="t('payroll.structures.monthlyBasic')"
                label-placement="stacked"
              />
            </ion-item>
            <ion-item v-else>
              <ion-input
                v-model="form.rate"
                type="number"
                :label="t('payroll.structures.rate')"
                label-placement="stacked"
              />
            </ion-item>
            <ion-list-header>{{ t('payroll.structures.allowances') }}</ion-list-header>
            <ion-item v-for="(a, i) in form.allowances" :key="i">
              <ion-input v-model="a.name" :placeholder="t('payroll.structures.allowanceName')" />
              <ion-input v-model="a.amount" type="number" placeholder="₹" />
              <ion-button
                slot="end"
                fill="clear"
                color="danger"
                :aria-label="t('payroll.structures.removeAllowance')"
                @click="form.allowances.splice(i, 1)"
                >✕</ion-button
              >
            </ion-item>
            <ion-button fill="clear" size="small" @click="form.allowances.push({ name: '', amount: '' })">
              {{ t('payroll.structures.addAllowance') }}
            </ion-button>
            <ion-item
              ><ion-checkbox v-model="form.pfApplicable">{{
                t('payroll.structures.pf')
              }}</ion-checkbox></ion-item
            >
            <ion-item
              ><ion-checkbox v-model="form.esiApplicable">{{
                t('payroll.structures.esi')
              }}</ion-checkbox></ion-item
            >
            <ion-item
              ><ion-checkbox v-model="form.ptApplicable">{{
                t('payroll.structures.pt')
              }}</ion-checkbox></ion-item
            >
            <ion-item
              ><ion-checkbox v-model="form.tdsApplicable">{{
                t('payroll.structures.tds')
              }}</ion-checkbox></ion-item
            >
            <ion-item v-if="form.tdsApplicable">
              <ion-input
                v-model="form.tdsPercent"
                type="number"
                :label="t('payroll.structures.tdsPercent')"
                label-placement="stacked"
              />
            </ion-item>
            <ion-item>
              <ion-input
                v-model="form.effectiveFrom"
                type="date"
                :label="t('payroll.effectiveFrom')"
                label-placement="stacked"
                required
              />
            </ion-item>
          </ion-list>
          <ion-button v-can="'payroll.create'" expand="block" type="submit" :disabled="saving">{{
            t('payroll.structures.saveRevision')
          }}</ion-button>
        </form>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
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
import { formatDate, formatMoney } from '@/core/format';
import { toast, toastError } from '@/core/toast';
import { hrApi, todayIso } from '../hr/api';
import { payrollApi, type SalaryStructure } from './api';

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

const { t } = useI18n();
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
    await toast(t('payroll.structures.saved'));
    await load();
  } catch (e) {
    await toastError(e);
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>
