<template>
  <ion-modal :is-open="!!invoice" @did-dismiss="close">
    <ion-header>
      <ion-toolbar>
        <ion-title>Pay invoice</ion-title>
        <ion-buttons slot="end"><ion-button @click="close">Close</ion-button></ion-buttons>
      </ion-toolbar>
    </ion-header>
    <ion-content v-if="invoice" class="ion-padding">
      <template v-if="!order">
        <p>
          <strong>{{ invoice.number }}</strong> · {{ INVOICE_KIND_LABELS[invoice.kind] }}
          <br />
          <span class="muted">Due {{ formatDay(invoice.dueDate) }}</span>
        </p>
        <ion-list lines="none">
          <ion-item>
            <ion-label>Invoice total</ion-label>
            <ion-note slot="end">{{ rupees(invoice.totalPaise) }}</ion-note>
          </ion-item>
          <ion-item v-if="invoice.paidPaise + invoice.creditedPaise > 0">
            <ion-label>Already paid or credited</ion-label>
            <ion-note slot="end">{{ rupees(invoice.paidPaise + invoice.creditedPaise) }}</ion-note>
          </ion-item>
        </ion-list>
        <ion-button expand="block" :disabled="busy || invoice.balancePaise <= 0" @click="start"
          >Proceed to pay {{ rupees(invoice.balancePaise) }}</ion-button
        >
      </template>
      <template v-else-if="order.gateway === 'mock'">
        <p class="muted">Test gateway. No real money moves. Choose how this checkout ends.</p>
        <h2>{{ rupees(order.payment.amountPaise) }}</h2>
        <p class="muted">Order {{ order.payment.gatewayOrderId }}</p>
        <ion-button expand="block" color="success" :disabled="busy" @click="complete('success')"
          >Pay now</ion-button
        >
        <ion-button expand="block" fill="outline" color="danger" :disabled="busy" @click="complete('failed')"
          >Simulate failure</ion-button
        >
      </template>
      <template v-else>
        <p>Complete the payment in the {{ order.gateway }} window, then tap below.</p>
        <ion-button v-if="checkoutUrl" expand="block" :href="checkoutUrl" target="_blank"
          >Open {{ order.gateway }}</ion-button
        >
        <ion-button expand="block" fill="outline" :disabled="busy" @click="check"
          >I've paid, check status</ion-button
        >
      </template>
    </ion-content>
  </ion-modal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
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
import type { SaasCheckoutDto, SaasInvoiceDto, SaasPaymentDto } from '@erp/shared';
import { toast, toastError } from '@/core/toast';
import { rupees } from '@/modules/hr/api';
import { billingApi } from '../api';
import { INVOICE_KIND_LABELS, formatDay } from '../format';
import { loadSubscriptionStatus } from '../status';

const props = defineProps<{ invoice: SaasInvoiceDto | null }>();
const emit = defineEmits<{ close: []; paid: [payment: SaasPaymentDto] }>();

const order = ref<SaasCheckoutDto | null>(null);
const busy = ref(false);
/** One key per attempt: a retried request resumes the same gateway order; a new attempt after a failure gets a new one. */
let attemptKey = crypto.randomUUID();

const checkoutUrl = computed(() => {
  const u = order.value?.checkout.url;
  return typeof u === 'string' ? u : undefined;
});

watch(
  () => props.invoice?.id,
  () => {
    order.value = null;
    attemptKey = crypto.randomUUID();
  },
);

function close() {
  if (props.invoice) emit('close');
}

async function start() {
  if (!props.invoice) return;
  busy.value = true;
  try {
    const o = await billingApi.checkout(props.invoice.id, attemptKey);
    if (o.payment.status === 'pending') order.value = o;
    else await settled(o.payment);
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

async function settled(payment: SaasPaymentDto) {
  if (payment.status === 'success') {
    await toast('Payment successful. Thank you!', 'success');
    void loadSubscriptionStatus(true).catch(() => undefined);
    emit('paid', payment);
    return;
  }
  if (payment.status === 'failed') {
    await toast('Payment failed. You can try again.', 'danger');
    order.value = null;
    attemptKey = crypto.randomUUID();
    return;
  }
  await toast('The payment is still pending. Check again in a moment.', 'medium');
}

async function complete(outcome: 'success' | 'failed') {
  if (!order.value) return;
  busy.value = true;
  try {
    await settled((await billingApi.mockComplete(order.value.payment.id, outcome)).payment);
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

async function check() {
  if (!order.value) return;
  busy.value = true;
  try {
    await settled((await billingApi.sync(order.value.payment.id)).payment);
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}
</script>
