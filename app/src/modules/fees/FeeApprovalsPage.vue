<template>
  <AppPage title="Fee approvals" :on-refresh="load">
    <ion-list>
      <ion-list-header>Offline payments awaiting approval</ion-list-header>
      <ion-item v-for="p in payments" :key="p.id">
        <ion-label>
          <h3>{{ p.studentName }} · {{ rupees(p.amount) }} {{ MODE_LABELS[p.mode] }}</h3>
          <p>
            {{ p.paidOn }}<span v-if="p.referenceNo"> · ref {{ p.referenceNo }}</span
            ><span v-if="p.chequeNumber"> · cheque {{ p.chequeNumber }} {{ p.bankName }}</span>
          </p>
          <p class="muted">{{ p.notes }}</p>
        </ion-label>
        <ion-buttons slot="end" v-can="'fees.approve'">
          <ion-button color="success" @click="decidePayment(p.id, true)">Approve</ion-button>
          <ion-button color="danger" @click="decidePayment(p.id, false)">Reject</ion-button>
        </ion-buttons>
      </ion-item>
      <ion-item v-if="!payments.length"><ion-label class="muted">Nothing pending.</ion-label></ion-item>

      <ion-list-header>Discounts & concessions awaiting approval</ion-list-header>
      <ion-item v-for="d in adjustments" :key="d.id" :router-link="`/fees/accounts/${d.accountId}`" detail>
        <ion-label>
          <h3>{{ d.type }} · {{ rupees(d.amount) }}</h3>
          <p>{{ d.reason }} · account #{{ d.accountId }}</p>
        </ion-label>
        <ion-buttons slot="end" v-can="'fees.approve'">
          <ion-button color="success" @click.prevent.stop="decideAdjustment(d.id, true)">Approve</ion-button>
          <ion-button color="danger" @click.prevent.stop="decideAdjustment(d.id, false)">Reject</ion-button>
        </ion-buttons>
      </ion-item>
      <ion-item v-if="!adjustments.length"><ion-label class="muted">Nothing pending.</ion-label></ion-item>
    </ion-list>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { IonButton, IonButtons, IonItem, IonLabel, IonList, IonListHeader } from '@ionic/vue';
import type { FeeAdjustmentDto, FeePaymentDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { rupees } from '../hr/api';
import { MODE_LABELS, feesApi } from './api';

const payments = ref<FeePaymentDto[]>([]);
const adjustments = ref<FeeAdjustmentDto[]>([]);

async function load() {
  try {
    const [p, a] = await Promise.all([
      feesApi.payments({ approval: 'pending' }),
      feesApi.adjustments('pending'),
    ]);
    payments.value = p.items;
    adjustments.value = a.items;
  } catch (e) {
    void toastError(e);
  }
}

async function act(fn: () => Promise<unknown>, msg: string) {
  try {
    await fn();
    await toast(msg);
    await load();
  } catch (e) {
    void toastError(e);
  }
}
const decidePayment = (id: number, ok: boolean) =>
  act(() => feesApi.decidePayment(id, ok), ok ? 'Payment approved; receipt issued' : 'Payment rejected');
const decideAdjustment = (id: number, ok: boolean) =>
  act(() => feesApi.decideAdjustment(id, ok), ok ? 'Concession applied' : 'Concession rejected');

onMounted(load);
</script>
