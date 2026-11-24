<template>
  <AppPage :title="t('payroll.my.title')" :on-refresh="load">
    <ion-list>
      <ion-item v-for="p in payslips" :key="p.id" button @click="selected = p">
        <ion-label>
          <h3>{{ formatMonth(p.periodYear, p.periodMonth) }}</h3>
          <p>
            {{
              t('payroll.slipLine', {
                gross: formatMoney(p.gross),
                deductions: formatMoney(p.totalDeductions),
              })
            }}
          </p>
        </ion-label>
        <ion-note slot="end">{{ formatMoney(p.net) }}</ion-note>
      </ion-item>
      <ion-item v-if="loaded && !payslips.length">
        <ion-label class="muted ion-text-wrap">{{ t('payroll.my.empty') }}</ion-label>
      </ion-item>
    </ion-list>

    <ion-modal :is-open="!!selected" @did-dismiss="selected = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{ t('payroll.payslip') }}</ion-title>
          <ion-buttons slot="end">
            <ion-button @click="pdf">{{ t('payroll.my.downloadPdf') }}</ion-button>
            <ion-button @click="selected = null">{{ t('common.actions.close') }}</ion-button>
          </ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content><PayslipView v-if="selected" :slip="selected" /></ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
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
} from '@ionic/vue';
import type { PayslipDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { ApiError } from '@/core/api';
import { formatMoney } from '@/core/format';
import { toast, toastError } from '@/core/toast';
import { formatMonth } from '../hr/api';
import { openSigned, payrollApi } from './api';
import PayslipView from './PayslipView.vue';

const { t } = useI18n();
const payslips = ref<PayslipDto[]>([]);
const selected = ref<PayslipDto | null>(null);
const loaded = ref(false);

async function load() {
  try {
    payslips.value = await payrollApi.myPayslips();
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) await toast(t('payroll.my.notLinked'), 'medium');
    else await toastError(e);
  } finally {
    loaded.value = true;
  }
}

async function pdf() {
  if (selected.value) await payrollApi.myPayslipPdf(selected.value.id).then(openSigned).catch(toastError);
}

onMounted(load);
</script>
