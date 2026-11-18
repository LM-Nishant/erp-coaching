<template>
  <AppPage title="SaaS payments" :on-refresh="refresh">
    <div class="filters">
      <ion-select v-model="status" label="Status" label-placement="stacked" interface="popover">
        <ion-select-option value="">All</ion-select-option>
        <ion-select-option value="success">Successful</ion-select-option>
        <ion-select-option value="pending">Pending</ion-select-option>
        <ion-select-option value="failed">Failed</ion-select-option>
      </ion-select>
      <ion-select v-model="method" label="Method" label-placement="stacked" interface="popover">
        <ion-select-option value="">All</ion-select-option>
        <ion-select-option value="gateway">Gateway</ion-select-option>
        <ion-select-option value="manual">Manual</ion-select-option>
      </ion-select>
      <ion-input v-model="from" label="From" label-placement="stacked" type="date" :max="to || undefined" />
      <ion-input v-model="to" label="To" label-placement="stacked" type="date" :min="from || undefined" />
    </div>
    <p class="muted hint">
      Pending gateway payments settle through the gateway webhook; use “Check status” if one seems stuck.
    </p>

    <BillingHistory
      admin
      :tabs="['payments']"
      :payment-filters="filters"
      :reload-key="reloadKey"
      @open="openInvoiceId = $event"
      @changed="refresh"
    />

    <InvoiceDetailModal
      :invoice-id="openInvoiceId"
      :source="adminInvoices"
      admin
      @close="openInvoiceId = null"
      @changed="refresh"
    />
  </AppPage>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { IonInput, IonSelect, IonSelectOption } from '@ionic/vue';
import type { SaasPaymentMethod, SaasPaymentStatus } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { adminInvoices, type PaymentFilters } from '../api';
import BillingHistory from '../components/BillingHistory.vue';
import InvoiceDetailModal from '../components/InvoiceDetailModal.vue';

const status = ref<SaasPaymentStatus | ''>('');
const method = ref<SaasPaymentMethod | ''>('');
const from = ref('');
const to = ref('');
const reloadKey = ref(0);
const openInvoiceId = ref<number | null>(null);

const filters = computed<PaymentFilters>(() => ({
  status: status.value || undefined,
  method: method.value || undefined,
  // An incomplete range (from after to) is ignored rather than rejected by the API.
  from: from.value && (!to.value || from.value <= to.value) ? from.value : undefined,
  to: to.value && (!from.value || from.value <= to.value) ? to.value : undefined,
}));

async function refresh() {
  reloadKey.value++;
}
</script>

<style scoped>
.filters {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 8px;
  padding: 0 8px 8px;
}
.hint {
  font-size: 13px;
  padding: 0 8px;
}
</style>
