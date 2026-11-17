<template>
  <AppPage title="Payroll reports">
    <ion-segment v-model="kind" @ion-change="table = null">
      <ion-segment-button value="statutory">Statutory (PF/ESI/PT/TDS)</ion-segment-button>
      <ion-segment-button value="annual">Annual summary</ion-segment-button>
      <ion-segment-button value="register">Salary register</ion-segment-button>
    </ion-segment>
    <ion-item v-if="kind === 'statutory'">
      <ion-input v-model="month" type="month" label="Month" label-placement="stacked" />
    </ion-item>
    <ion-item v-else-if="kind === 'annual'">
      <ion-input v-model.number="year" type="number" label="Year" label-placement="stacked" />
    </ion-item>
    <ion-item v-else>
      <ion-select v-model="runId" label="Payroll run" label-placement="stacked">
        <ion-select-option v-for="r in runs" :key="r.id" :value="r.id">
          {{ MONTHS[r.periodMonth - 1] }} {{ r.periodYear }} ({{ r.status }})
        </ion-select-option>
      </ion-select>
    </ion-item>
    <div class="actions">
      <ion-button @click="view">View</ion-button>
      <ion-button fill="outline" @click="download('csv')">CSV</ion-button>
      <ion-button fill="outline" @click="download('xls')">Excel</ion-button>
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
      <p v-if="!table.rows.length" class="muted">No locked payslips for this period.</p>
    </div>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
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
import { MONTHS, todayIso } from '../hr/api';
import { downloadReport, payrollApi, type ReportKind, type ReportTable } from './api';

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
