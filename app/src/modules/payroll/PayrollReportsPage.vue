<template>
  <AppPage :title="t('payroll.reports.title')">
    <ion-segment v-model="kind" @ion-change="table = null">
      <ion-segment-button value="statutory">{{ t('payroll.reports.statutory') }}</ion-segment-button>
      <ion-segment-button value="annual">{{ t('payroll.reports.annual') }}</ion-segment-button>
      <ion-segment-button value="register">{{ t('payroll.reports.register') }}</ion-segment-button>
    </ion-segment>
    <ion-item v-if="kind === 'statutory'">
      <ion-input v-model="month" type="month" :label="t('payroll.month')" label-placement="stacked" />
    </ion-item>
    <ion-item v-else-if="kind === 'annual'">
      <ion-input v-model.number="year" type="number" :label="t('payroll.year')" label-placement="stacked" />
    </ion-item>
    <ion-item v-else>
      <ion-select v-model="runId" :label="t('payroll.reports.run')" label-placement="stacked">
        <ion-select-option v-for="r in runs" :key="r.id" :value="r.id">
          {{ formatMonth(r.periodYear, r.periodMonth) }} ({{ t(RUN_STATUS[r.status].label) }})
        </ion-select-option>
      </ion-select>
    </ion-item>
    <div class="actions">
      <ion-button @click="view">{{ t('common.actions.view') }}</ion-button>
      <ion-button fill="outline" @click="download('csv')">{{ t('payroll.csv') }}</ion-button>
      <ion-button fill="outline" @click="download('xls')">{{ t('payroll.excel') }}</ion-button>
    </div>
    <div v-if="table" class="table-wrap">
      <table>
        <thead>
          <tr>
            <th v-for="h in table.headers" :key="h">{{ h }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(r, i) in table.rows" :key="i">
            <td v-for="(c, j) in r" :key="j">{{ c }}</td>
          </tr>
        </tbody>
      </table>
      <p v-if="!table.rows.length" class="muted">{{ t('payroll.reports.empty') }}</p>
    </div>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  IonButton,
  IonInput,
  IonItem,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
} from '@ionic/vue';
import type { PayrollRunDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toastError } from '@/core/toast';
import { formatMonth, todayIso } from '../hr/api';
import { RUN_STATUS, downloadReport, payrollApi, type ReportKind, type ReportTable } from './api';

const { t } = useI18n();

const kind = ref<ReportKind>('statutory');
const month = ref(todayIso().slice(0, 7));
const year = ref(new Date().getFullYear());
const runId = ref<number | null>(null);
const runs = ref<PayrollRunDto[]>([]);
const table = ref<ReportTable | null>(null);

function query(): Record<string, number> | null {
  if (kind.value === 'statutory') {
    const [y, m] = month.value.split('-').map(Number);
    return { year: y, month: m };
  }
  if (kind.value === 'annual') return { year: Number(year.value) };
  return runId.value ? { runId: runId.value } : null;
}

async function view() {
  const q = query();
  if (q) table.value = await payrollApi.report(kind.value, q).catch((e) => (toastError(e), null));
}

async function download(format: 'csv' | 'xls') {
  const q = query();
  if (q) await downloadReport(kind.value, q, format).catch(toastError);
}

onMounted(async () => {
  runs.value = (await payrollApi.runs().catch(() => ({ items: [] as PayrollRunDto[] }))).items;
  runId.value = runs.value[0]?.id ?? null;
});
</script>

<style scoped>
.actions {
  display: flex;
  gap: 4px;
  margin: 8px 0;
}
.table-wrap {
  overflow-x: auto;
}
table {
  border-collapse: collapse;
  font-size: 0.85rem;
  white-space: nowrap;
}
th,
td {
  border: 1px solid var(--ion-color-light-shade);
  padding: 4px 8px;
  text-align: left;
}
</style>
