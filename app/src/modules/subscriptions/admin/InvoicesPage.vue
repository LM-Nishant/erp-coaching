<template>
  <AppPage title="SaaS invoices" :on-refresh="refresh">
    <ion-searchbar v-model="search" :debounce="400" placeholder="Invoice number" />
    <div class="filters">
      <ion-select v-model="status" label="Status" label-placement="stacked" interface="popover">
        <ion-select-option value="">All</ion-select-option>
        <ion-select-option value="open">Open</ion-select-option>
        <ion-select-option value="paid">Paid</ion-select-option>
        <ion-select-option value="void">Void</ion-select-option>
      </ion-select>
      <ion-select v-model="kind" label="Type" label-placement="stacked" interface="popover">
        <ion-select-option value="">All</ion-select-option>
        <ion-select-option v-for="(label, k) in INVOICE_KIND_LABELS" :key="k" :value="k">{{
          label
        }}</ion-select-option>
      </ion-select>
    </div>
    <div v-if="instituteId" class="chip-row scope">
      <ion-chip @click="clearInstitute">
        <ion-label>{{ instituteName ?? `Institute #${instituteId}` }}</ion-label>
        <ion-icon :icon="closeCircle" />
      </ion-chip>
    </div>

    <BillingHistory
      admin
      :tabs="['invoices', 'credits']"
      :institute-id="instituteId"
      :invoice-filters="filters"
      :reload-key="reloadKey"
      @open="openInvoiceId = $event"
    />

    <InvoiceDetailModal
      :invoice-id="openInvoiceId"
      :source="adminInvoices"
      admin
      @close="openInvoiceId = null"
      @changed="reloadKey++"
    />
  </AppPage>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { IonChip, IonIcon, IonLabel, IonSearchbar, IonSelect, IonSelectOption } from '@ionic/vue';
import { closeCircle } from 'ionicons/icons';
import type { SaasInvoiceKind, SaasInvoiceStatus } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { adminApi } from '@/modules/admin/api';
import { adminInvoices, type InvoiceFilters } from '../api';
import BillingHistory from '../components/BillingHistory.vue';
import InvoiceDetailModal from '../components/InvoiceDetailModal.vue';
import { INVOICE_KIND_LABELS } from '../format';

const route = useRoute();
const router = useRouter();

const search = ref('');
const status = ref<SaasInvoiceStatus | ''>('');
const kind = ref<SaasInvoiceKind | ''>('');
const reloadKey = ref(0);
const openInvoiceId = ref<number | null>(null);
const instituteName = ref<string | null>(null);

/** `?instituteId=` scopes the list to one institute (kept while the page is in the background). */
const instituteId = ref<number | undefined>(undefined);
const filters = computed<InvoiceFilters>(() => ({
  status: status.value || undefined,
  kind: kind.value || undefined,
  search: search.value.trim() || undefined,
}));

async function refresh() {
  reloadKey.value++;
}

function clearInstitute() {
  void router.replace({ name: 'admin-billing-invoices' });
}

watch(
  () => (route.name === 'admin-billing-invoices' ? route.query.instituteId : null),
  async (raw) => {
    if (raw === null) return;
    const n = Number(raw);
    const next = Number.isInteger(n) && n > 0 ? n : undefined;
    if (next === instituteId.value) return;
    instituteId.value = next;
    instituteName.value = null;
    if (next) instituteName.value = (await adminApi.institute(next).catch(() => null))?.name ?? null;
  },
  { immediate: true },
);
</script>

<style scoped>
.filters {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 8px;
  padding: 0 8px 8px;
}
.scope {
  padding: 0 4px 8px;
}
</style>
