<template>
  <AppPage
    :title="run ? `Payroll ${MONTHS[run.periodMonth - 1]} ${run.periodYear}` : 'Payroll run'"
    back-href="/payroll/runs"
    :on-refresh="load"
  >
    <template v-if="run">
      <ion-item lines="none">
        <ion-label>
          <h2>
            <ion-badge
              :color="run.status === 'locked' ? 'success' : run.status === 'approved' ? 'warning' : 'medium'"
            >
              {{ run.status }}
            </ion-badge>
            {{ run.employeeCount }} employee(s)
          </h2>
          <p>
            Gross {{ rupees(run.totalGross) }} · deductions {{ rupees(run.totalDeductions) }} · net
            {{ rupees(run.totalNet) }} · employer {{ rupees(run.totalEmployer) }}
          </p>
        </ion-label>
      </ion-item>
      <div class="actions">
        <template v-if="run.status === 'draft'">
          <ion-button
            v-can="'payroll.create'"
            @click="act(() => payrollApi.generate(run!.id), 'Payslips regenerated')"
          >
            Regenerate
          </ion-button>
          <ion-button v-can="'payroll.approve'" color="warning" @click="transition('approve')"
            >Approve</ion-button
          >
          <ion-button v-can="'payroll.delete'" color="danger" fill="outline" @click="remove"
            >Delete</ion-button
          >
        </template>
        <template v-if="run.status === 'approved'">
          <ion-button v-can="'payroll.approve'" color="success" @click="transition('lock')"
            >Lock & publish</ion-button
          >
          <ion-button v-can="'payroll.approve'" fill="outline" @click="transition('reopen')"
            >Reopen</ion-button
          >
        </template>
        <ion-button v-can="'payroll.export'" fill="outline" @click="exportRegister('csv')">CSV</ion-button>
        <ion-button v-can="'payroll.export'" fill="outline" @click="exportRegister('xls')">Excel</ion-button>
      </div>
      <ion-item v-for="s in skipped" :key="s.employeeId" color="light">
        <ion-label class="ion-text-wrap">Skipped {{ s.name }}: {{ s.reason }}</ion-label>
      </ion-item>
      <ion-list>
        <ion-item v-for="p in payslips" :key="p.id" button @click="selected = p">
          <ion-label>
            <h3>{{ p.employee?.name }}</h3>
            <p>{{ p.employee?.employeeCode }} · LOP {{ p.lopDays }} · gross {{ rupees(p.gross) }}</p>
          </ion-label>
          <ion-note slot="end">{{ rupees(p.net) }}</ion-note>
        </ion-item>
      </ion-list>
    </template>

    <ion-modal :is-open="!!selected" @did-dismiss="selected = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>Payslip</ion-title>
          <ion-buttons slot="end">
            <ion-button v-if="run?.status === 'locked'" @click="pdf">PDF</ion-button>
            <ion-button @click="selected = null">Close</ion-button>
          </ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content><PayslipView v-if="selected" :slip="selected" /></ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonNote,
  IonTitle,
  IonToolbar,
  alertController,
} from '@ionic/vue';
import type { PayrollRunDto, PayslipDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { MONTHS, rupees } from '../hr/api';
import { downloadReport, openSigned, payrollApi } from './api';
import PayslipView from './PayslipView.vue';

const route = useRoute();
const router = useRouter();
const id = computed(() => Number(route.params.id));
const run = ref<PayrollRunDto | null>(null);
const payslips = ref<PayslipDto[]>([]);
const skipped = ref<{ employeeId: number; name: string; reason: string }[]>([]);
const selected = ref<PayslipDto | null>(null);

async function load() {
  try {
    ({ run: run.value, payslips: payslips.value } = await payrollApi.run(id.value));
  } catch (e) {
    await toastError(e);
  }
}

async function act(fn: () => Promise<unknown>, message: string) {
  try {
    const res = await fn();
    if (res && typeof res === 'object' && 'skipped' in res)
      skipped.value = (res as { skipped: typeof skipped.value }).skipped;
    await toast(message);
    await load();
  } catch (e) {
    await toastError(e);
  }
}

async function transition(action: 'approve' | 'reopen' | 'lock') {
  const alert = await alertController.create({
    header: `${action[0].toUpperCase()}${action.slice(1)} this run?`,
    message:
      action === 'lock' ? 'Locked runs cannot be changed; payslips become visible to employees.' : undefined,
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      {
        text: 'Confirm',
        handler: () => act(() => payrollApi.transition(id.value, action), `Run ${action}d`),
      },
    ],
  });
  await alert.present();
}

async function remove() {
  await payrollApi
    .removeRun(id.value)
    .then(() => router.replace('/payroll/runs'))
    .catch(toastError);
}

async function pdf() {
  if (selected.value) await payrollApi.payslipPdf(selected.value.id).then(openSigned).catch(toastError);
}

async function exportRegister(format: 'csv' | 'xls') {
  await downloadReport('register', { runId: id.value }, format).catch(toastError);
}

onMounted(load);
</script>

<style scoped>
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 8px 0;
}
</style>
