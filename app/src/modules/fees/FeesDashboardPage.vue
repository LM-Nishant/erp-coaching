<template>
  <AppPage title="Fees" :on-refresh="load">
    <div v-if="s" class="stats">
      <StatCard label="Collected today" :value="rupees(s.todayCollection)" />
      <StatCard label="Collected this month" :value="rupees(s.monthCollection)" />
      <StatCard label="Outstanding" :value="rupees(s.outstanding)" />
      <StatCard label="Overdue" :value="rupees(s.overdue)" :hint="`${s.defaulters} defaulter(s)`" />
      <StatCard label="Payments awaiting approval" :value="s.pendingPaymentApprovals" />
      <StatCard label="Concessions awaiting approval" :value="s.pendingAdjustments" />
    </div>
    <ion-list>
      <ion-item router-link="/fees/accounts" detail><ion-label>Student fee accounts</ion-label></ion-item>
      <ion-item router-link="/fees/structures" detail
        ><ion-label>Fee structures & instalment plans</ion-label></ion-item
      >
      <ion-item router-link="/fees/approvals" detail><ion-label>Approvals</ion-label></ion-item>
      <ion-item router-link="/fees/reports" detail
        ><ion-label>Daily cash, collections & dues reports</ion-label></ion-item
      >
      <ion-item v-can="'accounting.view'" router-link="/accounting" detail
        ><ion-label>Expenses, income & P&amp;L</ion-label></ion-item
      >
      <ion-item v-can="'accounting.view'" router-link="/accounting/banks" detail
        ><ion-label>Bank accounts & reconciliation</ion-label></ion-item
      >
      <ion-item v-can="'fees.configure'" router-link="/fees/settings" detail
        ><ion-label>Settings: GST, late fees, gateways, concessions</ion-label></ion-item
      >
    </ion-list>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { IonItem, IonLabel, IonList } from '@ionic/vue';
import AppPage from '@/components/AppPage.vue';
import StatCard from '@/components/StatCard.vue';
import { toastError } from '@/core/toast';
import { rupees } from '../hr/api';
import { feesApi, type FeeSummary } from './api';

const s = ref<FeeSummary | null>(null);
async function load() {
  try {
    s.value = await feesApi.summary();
  } catch (e) {
    void toastError(e);
  }
}
onMounted(load);
</script>

<style scoped>
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}
</style>
