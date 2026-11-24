<template>
  <AppPage
    :title="
      run
        ? t('payroll.run.title', { period: formatMonth(run.periodYear, run.periodMonth) })
        : t('payroll.run.fallbackTitle')
    "
    back-href="/payroll/runs"
    :on-refresh="load"
  >
    <template v-if="run">
      <ion-item lines="none">
        <ion-label>
          <h2>
            <StatusChip :label="t(RUN_STATUS[run.status].label)" :tone="RUN_STATUS[run.status].tone" />
            {{ t('payroll.employees', run.employeeCount) }}
          </h2>
          <p>
            {{
              t('payroll.run.totals', {
                gross: formatMoney(run.totalGross),
                deductions: formatMoney(run.totalDeductions),
                net: formatMoney(run.totalNet),
                employer: formatMoney(run.totalEmployer),
              })
            }}
          </p>
        </ion-label>
      </ion-item>
      <div class="actions">
        <template v-if="run.status === 'draft'">
          <ion-button
            v-can="'payroll.create'"
            @click="act(() => payrollApi.generate(run!.id), t('payroll.run.regenerated'))"
          >
            {{ t('payroll.run.regenerate') }}
          </ion-button>
          <ion-button v-can="'payroll.approve'" color="warning" @click="transition('approve')">{{
            t('common.actions.approve')
          }}</ion-button>
          <ion-button v-can="'payroll.delete'" color="danger" fill="outline" @click="remove">{{
            t('common.actions.delete')
          }}</ion-button>
        </template>
        <template v-if="run.status === 'approved'">
          <ion-button v-can="'payroll.approve'" color="success" @click="transition('lock')">{{
            t('payroll.run.lock')
          }}</ion-button>
          <ion-button v-can="'payroll.approve'" fill="outline" @click="transition('reopen')">{{
            t('payroll.run.reopen')
          }}</ion-button>
        </template>
        <ion-button v-can="'payroll.export'" fill="outline" @click="exportRegister('csv')">{{
          t('payroll.csv')
        }}</ion-button>
        <ion-button v-can="'payroll.export'" fill="outline" @click="exportRegister('xls')">{{
          t('payroll.excel')
        }}</ion-button>
      </div>
      <ion-item v-for="s in skipped" :key="s.employeeId" color="light">
        <ion-label class="ion-text-wrap">{{
          t('payroll.run.skipped', { name: s.name, reason: s.reason })
        }}</ion-label>
      </ion-item>
      <ion-list>
        <ion-item v-for="p in payslips" :key="p.id" button @click="selected = p">
          <ion-label>
            <h3>{{ p.employee?.name }}</h3>
            <p>
              {{
                t('payroll.run.row', {
                  code: p.employee?.employeeCode ?? '',
                  lop: formatNumber(p.lopDays),
                  gross: formatMoney(p.gross),
                })
              }}
            </p>
          </ion-label>
          <ion-note slot="end">{{ formatMoney(p.net) }}</ion-note>
        </ion-item>
      </ion-list>
    </template>

    <ion-modal :is-open="!!selected" @did-dismiss="selected = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{ t('payroll.payslip') }}</ion-title>
          <ion-buttons slot="end">
            <ion-button v-if="run?.status === 'locked'" @click="pdf">{{ t('payroll.pdf') }}</ion-button>
            <ion-button @click="selected = null">{{ t('common.actions.close') }}</ion-button>
          </ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content><PayslipView v-if="selected" :slip="selected" /></ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import {
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
import StatusChip from '@/components/StatusChip.vue';
import { formatMoney, formatNumber } from '@/core/format';
import { toast, toastError } from '@/core/toast';
import { formatMonth } from '../hr/api';
import { RUN_STATUS, downloadReport, openSigned, payrollApi } from './api';
import PayslipView from './PayslipView.vue';

const { t } = useI18n();
const CONFIRM = {
  approve: { header: 'payroll.run.confirmApprove', done: 'payroll.run.approved' },
  lock: { header: 'payroll.run.confirmLock', done: 'payroll.run.locked' },
  reopen: { header: 'payroll.run.confirmReopen', done: 'payroll.run.reopened' },
} as const;

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
    header: t(CONFIRM[action].header),
    message: action === 'lock' ? t('payroll.run.lockMessage') : undefined,
    buttons: [
      { text: t('common.actions.cancel'), role: 'cancel' },
      {
        text: t('common.actions.confirm'),
        handler: () => act(() => payrollApi.transition(id.value, action), t(CONFIRM[action].done)),
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
