<template>
  <div>
    <ion-segment v-if="tabs.length > 1" v-model="tab">
      <ion-segment-button v-for="t in tabs" :key="t" :value="t"
        ><ion-label>{{ TAB_LABELS[t] }}</ion-label></ion-segment-button
      >
    </ion-segment>

    <ion-list v-if="tab === 'invoices'">
      <ion-item v-for="i in invoices.items" :key="i.id" button :detail="false" @click="emit('open', i.id)">
        <ion-label class="ion-text-wrap">
          {{ i.number }} · {{ INVOICE_KIND_LABELS[i.kind] }}
          <p>
            <template v-if="showInstitute">{{ i.instituteName }} · </template>Issued
            {{ formatDay(i.issueDate) }}
            <template v-if="i.status === 'open'"> · due {{ formatDay(i.dueDate) }}</template>
          </p>
        </ion-label>
        <div slot="end" class="end">
          <div>{{ rupees(i.totalPaise) }}</div>
          <ion-badge :color="INVOICE_STATUS_COLORS[i.status]">{{ i.status }}</ion-badge>
        </div>
      </ion-item>
      <p v-if="!invoices.items.length && !loading" class="muted ion-padding">No invoices.</p>
    </ion-list>

    <ion-list v-else-if="tab === 'payments'">
      <ion-item
        v-for="p in payments.items"
        :key="p.id"
        :button="!!p.invoiceId"
        :detail="false"
        @click="p.invoiceId && emit('open', p.invoiceId)"
      >
        <ion-label class="ion-text-wrap">
          {{ rupees(p.amountPaise) }} · {{ p.method === 'manual' ? 'Manual' : (p.gateway ?? 'Gateway') }}
          <p>
            <template v-if="showInstitute">{{ p.instituteName }} · </template>
            {{ formatDateTime(p.paidAt ?? p.createdAt) }}
            <template v-if="p.invoiceNumber"> · {{ p.invoiceNumber }}</template>
            <template v-if="p.reference"> · Ref {{ p.reference }}</template>
          </p>
        </ion-label>
        <ion-button
          v-if="p.status === 'pending' && p.method === 'gateway'"
          slot="end"
          size="small"
          fill="clear"
          :disabled="syncing === p.id"
          @click.stop="sync(p)"
          >Check status</ion-button
        >
        <ion-badge slot="end" :color="PAYMENT_STATUS_COLORS[p.status]">{{ p.status }}</ion-badge>
      </ion-item>
      <p v-if="!payments.items.length && !loading" class="muted ion-padding">No payments.</p>
    </ion-list>

    <ion-list v-else>
      <ion-item v-for="c in credits.items" :key="c.id">
        <ion-label class="ion-text-wrap">
          {{ c.number }} · {{ rupees(c.amountPaise) }}
          <p>
            <template v-if="showInstitute">{{ c.instituteName }} · </template>{{ formatDate(c.createdAt) }} ·
            against {{ c.invoiceNumber }} · {{ c.reason }}
          </p>
        </ion-label>
        <ion-button slot="end" fill="clear" aria-label="Credit note PDF" @click="creditPdf(c.id)"
          ><ion-icon :icon="downloadOutline"
        /></ion-button>
      </ion-item>
      <p v-if="!credits.items.length && !loading" class="muted ion-padding">No credit notes.</p>
    </ion-list>

    <ion-button v-if="hasMore" fill="clear" expand="block" :disabled="loading" @click="loadMore"
      >Load more</ion-button
    >
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import {
  IonBadge,
  IonButton,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonSegment,
  IonSegmentButton,
} from '@ionic/vue';
import { downloadOutline } from 'ionicons/icons';
import type { Paginated, SaasCreditNoteDto, SaasInvoiceDto, SaasPaymentDto } from '@erp/shared';
import { toast, toastError } from '@/core/toast';
import { rupees } from '@/modules/hr/api';
import { billingAdminApi, billingApi, openLink, type InvoiceFilters, type PaymentFilters } from '../api';
import {
  INVOICE_KIND_LABELS,
  INVOICE_STATUS_COLORS,
  PAYMENT_STATUS_COLORS,
  formatDate,
  formatDateTime,
  formatDay,
} from '../format';

type Tab = 'invoices' | 'payments' | 'credits';
const TAB_LABELS: Record<Tab, string> = {
  invoices: 'Invoices',
  payments: 'Payments',
  credits: 'Credit notes',
};

/** Tenant mode uses `/subscription`; admin mode lists one institute (or all when `instituteId` is unset). */
const props = withDefaults(
  defineProps<{
    admin?: boolean;
    instituteId?: number;
    reloadKey?: number;
    tabs?: Tab[];
    invoiceFilters?: InvoiceFilters;
    paymentFilters?: PaymentFilters;
  }>(),
  {
    admin: false,
    instituteId: undefined,
    reloadKey: 0,
    tabs: () => ['invoices', 'payments', 'credits'],
    invoiceFilters: () => ({}),
    paymentFilters: () => ({}),
  },
);
const emit = defineEmits<{ open: [invoiceId: number]; changed: [] }>();

const PAGE_SIZE = 20;
const empty = <T,>(): Paginated<T> => ({ items: [], total: 0, page: 0, pageSize: PAGE_SIZE });

const tab = ref<Tab>(props.tabs[0] ?? 'invoices');
const syncing = ref<number | null>(null);
const loading = ref(false);
const invoices = reactive(empty<SaasInvoiceDto>());
const payments = reactive(empty<SaasPaymentDto>());
const credits = reactive(empty<SaasCreditNoteDto>());
const showInstitute = computed(() => props.admin && !props.instituteId);

const current = () => (tab.value === 'invoices' ? invoices : tab.value === 'payments' ? payments : credits);
const hasMore = computed(() => {
  const list = current();
  return list.items.length < list.total;
});

function fetchPage(t: Tab, page: number): Promise<Paginated<unknown>> {
  const q = { page, pageSize: PAGE_SIZE };
  if (!props.admin) {
    if (t === 'invoices') return billingApi.invoices({ ...q, ...props.invoiceFilters });
    if (t === 'payments') return billingApi.payments({ ...q, ...props.paymentFilters });
    return billingApi.creditNotes(q);
  }
  const scoped = { ...q, instituteId: props.instituteId };
  if (t === 'invoices') return billingAdminApi.invoices({ ...scoped, ...props.invoiceFilters });
  if (t === 'payments') return billingAdminApi.payments({ ...scoped, ...props.paymentFilters });
  return billingAdminApi.creditNotes(scoped);
}

async function load(t: Tab, page: number) {
  loading.value = true;
  try {
    const result = await fetchPage(t, page);
    const list = (t === 'invoices' ? invoices : t === 'payments' ? payments : credits) as Paginated<unknown>;
    list.items = page === 1 ? result.items : [...list.items, ...result.items];
    list.total = result.total;
    list.page = result.page;
  } catch (e) {
    void toastError(e);
  } finally {
    loading.value = false;
  }
}

const loadMore = () => load(tab.value, current().page + 1);

async function creditPdf(id: number) {
  try {
    openLink(await (props.admin ? billingAdminApi : billingApi).creditNotePdf(id));
  } catch (e) {
    void toastError(e);
  }
}

async function sync(p: SaasPaymentDto) {
  syncing.value = p.id;
  try {
    const result = await (props.admin ? billingAdminApi.syncPayment(p.id) : billingApi.sync(p.id));
    payments.items = payments.items.map((x) => (x.id === p.id ? result.payment : x));
    if (result.payment.status === 'pending') await toast('The gateway has not confirmed it yet', 'medium');
    else {
      await toast(result.payment.status === 'success' ? 'Payment confirmed' : 'The payment failed', 'medium');
      emit('changed');
    }
  } catch (e) {
    void toastError(e);
  } finally {
    syncing.value = null;
  }
}

watch(tab, (t) => void load(t, 1));
watch(
  () => [
    props.reloadKey,
    props.instituteId,
    JSON.stringify(props.invoiceFilters),
    JSON.stringify(props.paymentFilters),
  ],
  () => void load(tab.value, 1),
  { immediate: true },
);
</script>

<style scoped>
.end {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  font-size: 14px;
}
</style>
