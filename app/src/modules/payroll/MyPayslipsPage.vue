<template>
  <AppPage title="My payslips" :on-refresh="load">
    <ion-list>
      <ion-item v-for="p in payslips" :key="p.id" button @click="selected = p">
        <ion-label>
          <h3>{{ MONTHS[p.periodMonth - 1] }} {{ p.periodYear }}</h3>
          <p>Gross {{ rupees(p.gross) }} · deductions {{ rupees(p.totalDeductions) }}</p>
        </ion-label>
        <ion-note slot="end">{{ rupees(p.net) }}</ion-note>
      </ion-item>
      <ion-item v-if="loaded && !payslips.length">
        <ion-label class="muted ion-text-wrap"
          >No payslips yet. They appear here once payroll is locked.</ion-label
        >
      </ion-item>
    </ion-list>

    <ion-modal :is-open="!!selected" @did-dismiss="selected = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>Payslip</ion-title>
          <ion-buttons slot="end">
            <ion-button @click="pdf">Download PDF</ion-button>
            <ion-button @click="selected = null">Close</ion-button>
          </ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content><PayslipView v-if="selected" :slip="selected" /></ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
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
import { toast, toastError } from '@/core/toast';
import { MONTHS, rupees } from '../hr/api';
import { openSigned, payrollApi } from './api';
import PayslipView from './PayslipView.vue';

const payslips = ref<PayslipDto[]>([]);
const selected = ref<PayslipDto | null>(null);
const loaded = ref(false);

async function load() {
  try {
    payslips.value = await payrollApi.myPayslips();
  } catch (e) {
    if (e instanceof ApiError && e.status === 404)
      await toast('Your login is not linked to a staff profile.', 'medium');
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
