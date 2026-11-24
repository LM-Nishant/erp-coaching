<template>
  <AppPage :title="t('payroll.components.title')" :on-refresh="load">
    <template #actions>
      <ion-button v-can="'payroll.configure'" :aria-label="t('payroll.components.new')" @click="edit()"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>
    <p class="muted">{{ t('payroll.components.intro') }}</p>
    <ion-list>
      <ion-item v-for="c in components" :key="c.id" button @click="edit(c)">
        <ion-label class="ion-text-wrap">
          <h3>
            {{ c.name }} ({{ c.code }})
            <StatusChip v-if="c.statutory" :label="t('payroll.components.statutory')" tone="primary" />
            <StatusChip v-if="!c.active" :label="t('common.status.inactive')" />
          </h3>
          <p>{{ describe(c) }}</p>
          <p class="muted">
            {{
              c.effectiveTo
                ? t('payroll.components.range', {
                    from: formatDate(c.effectiveFrom),
                    to: formatDate(c.effectiveTo),
                  })
                : t('payroll.fromDate', { date: formatDate(c.effectiveFrom) })
            }}
          </p>
        </ion-label>
      </ion-item>
    </ion-list>

    <ion-modal :is-open="!!form" @did-dismiss="form = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{ form?.id ? t('payroll.components.edit') : t('payroll.components.new') }}</ion-title>
          <ion-buttons slot="end"
            ><ion-button @click="form = null">{{ t('common.actions.close') }}</ion-button></ion-buttons
          >
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <form v-if="form" @submit.prevent="save">
          <ion-list>
            <ion-item
              ><ion-input
                v-model="form.code"
                :label="t('payroll.components.code')"
                label-placement="stacked"
                required
            /></ion-item>
            <ion-item
              ><ion-input
                v-model="form.name"
                :label="t('common.labels.name')"
                label-placement="stacked"
                required
            /></ion-item>
            <ion-item>
              <ion-select v-model="form.kind" :label="t('payroll.components.kind')" label-placement="stacked">
                <ion-select-option value="earning">{{ t('payroll.components.earning') }}</ion-select-option>
                <ion-select-option value="deduction">{{
                  t('payroll.components.deduction')
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-select
                v-model="form.calcType"
                :label="t('payroll.components.calculation')"
                label-placement="stacked"
              >
                <ion-select-option value="percent">{{ t('payroll.components.percent') }}</ion-select-option>
                <ion-select-option value="fixed">{{ t('payroll.components.fixed') }}</ion-select-option>
                <ion-select-option value="slab">{{ t('payroll.components.slab') }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-select v-model="form.base" :label="t('payroll.components.base')" label-placement="stacked">
                <ion-select-option value="basic">{{ t('payroll.components.basic') }}</ion-select-option>
                <ion-select-option value="gross">{{ t('payroll.components.gross') }}</ion-select-option>
              </ion-select>
            </ion-item>
            <template v-if="form.calcType === 'percent'">
              <ion-item
                ><ion-input
                  v-model="form.employeeRate"
                  type="number"
                  :label="t('payroll.components.employeeRate')"
                  label-placement="stacked"
              /></ion-item>
              <ion-item
                ><ion-input
                  v-model="form.employerRate"
                  type="number"
                  :label="t('payroll.components.employerRate')"
                  label-placement="stacked"
              /></ion-item>
              <ion-item
                ><ion-input
                  v-model="form.wageCeiling"
                  type="number"
                  :label="t('payroll.components.wageCeiling')"
                  label-placement="stacked"
              /></ion-item>
            </template>
            <ion-item v-if="form.calcType === 'fixed'">
              <ion-input
                v-model="form.fixedAmount"
                type="number"
                :label="t('payroll.amountRupees')"
                label-placement="stacked"
              />
            </ion-item>
            <template v-if="form.calcType === 'slab'">
              <ion-list-header>{{ t('payroll.components.slabsHeader') }}</ion-list-header>
              <ion-item v-for="(s, i) in form.slabs" :key="i">
                <ion-input v-model="s.upTo" type="number" :placeholder="t('payroll.components.upTo')" />
                <ion-input v-model="s.amount" type="number" :placeholder="t('payroll.components.amount')" />
                <ion-button
                  slot="end"
                  fill="clear"
                  color="danger"
                  :aria-label="t('payroll.components.removeSlab')"
                  @click="form.slabs.splice(i, 1)"
                  >✕</ion-button
                >
              </ion-item>
              <ion-button fill="clear" size="small" @click="form.slabs.push({ upTo: '', amount: '' })">{{
                t('payroll.components.addSlab')
              }}</ion-button>
            </template>
            <ion-item>
              <ion-input
                v-model="form.eligibilityMaxGross"
                type="number"
                :label="t('payroll.components.eligibility')"
                label-placement="stacked"
              />
            </ion-item>
            <ion-item
              ><ion-input
                v-model="form.effectiveFrom"
                type="date"
                :label="t('payroll.effectiveFrom')"
                label-placement="stacked"
                required
            /></ion-item>
            <ion-item
              ><ion-input
                v-model="form.effectiveTo"
                type="date"
                :label="t('payroll.components.effectiveTo')"
                label-placement="stacked"
            /></ion-item>
            <ion-item
              ><ion-checkbox v-model="form.active">{{ t('common.status.active') }}</ion-checkbox></ion-item
            >
          </ion-list>
          <ion-button v-can="'payroll.configure'" expand="block" type="submit">{{
            t('common.actions.save')
          }}</ion-button>
          <ion-button
            v-if="form.id"
            v-can="'payroll.configure'"
            expand="block"
            fill="clear"
            color="danger"
            @click="remove"
          >
            {{ t('common.actions.delete') }}
          </ion-button>
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
import type { PayrollComponentDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import StatusChip from '@/components/StatusChip.vue';
import { formatDate, formatMoney, formatNumber } from '@/core/format';
import { toast, toastError } from '@/core/toast';
import { todayIso } from '../hr/api';
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

const { t } = useI18n();
const components = ref<PayrollComponentDto[]>([]);
const form = ref<Form | null>(null);
const str = (v: number | string | null | undefined, paise = false) =>
  v === null || v === undefined ? '' : String(paise ? Number(v) / 100 : v);
const num = (v: string, paise = false) => (v === '' ? null : paise ? Math.round(Number(v) * 100) : Number(v));

function describe(c: PayrollComponentDto) {
  const parts: string[] = [];
  if (c.calcType === 'percent') {
    parts.push(t('payroll.components.descEmployee', { rate: formatNumber(c.employeeRate ?? 0) }));
    if (c.employerRate)
      parts.push(t('payroll.components.descEmployer', { rate: formatNumber(c.employerRate) }));
    parts.push(
      t('payroll.components.descOf', {
        base: t(`payroll.components.${c.base === 'gross' ? 'gross' : 'basic'}`),
      }),
    );
    if (c.wageCeiling)
      parts.push(t('payroll.components.descCeiling', { amount: formatMoney(c.wageCeiling) }));
    const text = parts.join(' ');
    return c.eligibilityMaxGross
      ? `${text}, ${t('payroll.components.descIfGross', { amount: formatMoney(c.eligibilityMaxGross) })}`
      : text;
  }
  if (c.calcType === 'fixed')
    return t('payroll.components.descFixed', { amount: formatMoney(c.fixedAmount ?? 0) });
  return (c.slabs ?? [])
    .map(
      (s) =>
        `${s.upTo === null ? t('payroll.components.descAbove') : t('payroll.components.descUpTo', { amount: formatMoney(s.upTo) })}: ${formatMoney(s.amount)}`,
    )
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
    await toast(t('payroll.components.saved'));
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
