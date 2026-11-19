<template>
  <AppPage title="My fees" :on-refresh="load">
    <ion-segment
      v-if="(data?.students.length ?? 0) > 1"
      :value="studentId"
      @ion-change="switchStudent($event.detail.value)"
    >
      <ion-segment-button v-for="s in data?.students" :key="s.id" :value="s.id">{{
        s.name
      }}</ion-segment-button>
    </ion-segment>

    <template v-if="data">
      <ion-card>
        <ion-card-header>
          <ion-card-subtitle>{{ data.student.name }} · {{ data.student.admissionNumber }}</ion-card-subtitle>
          <ion-card-title>{{
            data.totalDue ? `${rupees(data.totalDue)} due` : 'All fees paid'
          }}</ion-card-title>
        </ion-card-header>
      </ion-card>

      <ion-card v-for="a in data.accounts" :key="a.id">
        <ion-card-header>
          <ion-card-subtitle>{{ a.title }}</ion-card-subtitle>
          <ion-card-title
            >{{ rupees(a.balance) }} <small class="muted">of {{ rupees(a.net) }}</small></ion-card-title
          >
        </ion-card-header>
        <ion-card-content>
          <ion-list lines="inset">
            <ion-item v-for="i in a.instalments ?? []" :key="i.id">
              <ion-label>
                <h3>{{ i.label }}</h3>
                <p>
                  Due {{ i.dueDate }} · {{ rupees(i.amount + i.lateFee)
                  }}<span v-if="i.lateFee"> (incl. late fee {{ rupees(i.lateFee) }})</span>
                </p>
              </ion-label>
              <ion-badge slot="end" :color="i.overdue ? 'danger' : STATUS_COLORS[i.status]">{{
                i.overdue ? 'overdue' : i.status
              }}</ion-badge>
            </ion-item>
            <ion-item v-if="a.discount">
              <ion-label class="muted">Concessions applied: {{ rupees(a.discount) }}</ion-label>
            </ion-item>
          </ion-list>
          <ion-button
            v-if="a.balance > 0 && a.status === 'active' && data.gateways.length"
            v-can="'my-fees.create'"
            expand="block"
            @click="startPay(a)"
            >Pay online</ion-button
          >
          <p v-else-if="a.balance > 0 && !data.gateways.length" class="muted">
            Online payment is not enabled; please pay at the office.
          </p>
        </ion-card-content>
      </ion-card>

      <ion-list>
        <ion-list-header>Payments & receipts</ion-list-header>
        <ion-item v-for="p in data.payments" :key="p.id">
          <ion-label>
            <h3>{{ rupees(p.amount) }} · {{ MODE_LABELS[p.mode] }}</h3>
            <p>
              {{ p.paidOn ?? p.createdAt.slice(0, 10)
              }}<span v-if="p.receiptNumber"> · {{ p.receiptNumber }}</span>
            </p>
          </ion-label>
          <ion-badge slot="end" :color="STATUS_COLORS[p.status]">{{ p.status.replace('_', ' ') }}</ion-badge>
          <ion-buttons v-if="p.receiptId" slot="end">
            <ion-button title="Download receipt" aria-label="Download receipt" @click="pdf(p.receiptId)"
              ><ion-icon slot="icon-only" :icon="downloadOutline"
            /></ion-button>
            <ion-button title="Send to WhatsApp" aria-label="Send to WhatsApp" @click="share(p.receiptId)"
              ><ion-icon slot="icon-only" :icon="logoWhatsapp"
            /></ion-button>
          </ion-buttons>
          <ion-button
            v-else-if="p.status === 'pending' && p.mode === 'online'"
            slot="end"
            fill="clear"
            @click="refreshPayment(p.id)"
            >Check status</ion-button
          >
        </ion-item>
        <ion-item v-if="!data.payments.length"
          ><ion-label class="muted">No payments yet.</ion-label></ion-item
        >
      </ion-list>
    </template>

    <ion-modal :is-open="!!payFor" @did-dismiss="closePay">
      <ion-header>
        <ion-toolbar>
          <ion-title>Pay fees</ion-title>
          <ion-buttons slot="end"><ion-button @click="closePay">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content v-if="payFor" class="ion-padding">
        <template v-if="!order">
          <p>{{ payFor.title }}</p>
          <ion-list>
            <ion-radio-group v-model="payChoice">
              <ion-item v-if="nextDue">
                <ion-radio value="next">Next instalment · {{ rupees(nextDue) }}</ion-radio>
              </ion-item>
              <ion-item
                ><ion-radio value="full">Full balance · {{ rupees(payFor.balance) }}</ion-radio></ion-item
              >
              <ion-item><ion-radio value="custom">Other amount</ion-radio></ion-item>
            </ion-radio-group>
            <ion-item v-if="payChoice === 'custom'">
              <ion-input v-model="customAmount" type="number" label="Amount (₹)" label-placement="stacked" />
            </ion-item>
            <ion-item v-if="(data?.gateways.length ?? 0) > 1">
              <ion-select v-model="gateway" label="Pay with" label-placement="stacked">
                <ion-select-option v-for="g in data?.gateways" :key="g" :value="g">{{ g }}</ion-select-option>
              </ion-select>
            </ion-item>
          </ion-list>
          <ion-button expand="block" :disabled="busy" @click="checkout"
            >Proceed to pay {{ rupees(payAmount) }}</ion-button
          >
        </template>
        <template v-else-if="order.gateway === 'mock'">
          <p class="muted">Test gateway. No real money moves. Choose how this checkout ends.</p>
          <h2>{{ rupees(order.amount) }}</h2>
          <p class="muted selectable">Order {{ order.gatewayOrderId }}</p>
          <ion-button expand="block" color="success" :disabled="busy" @click="complete('success')"
            >Pay now</ion-button
          >
          <ion-button
            expand="block"
            fill="outline"
            color="danger"
            :disabled="busy"
            @click="complete('failed')"
            >Simulate failure</ion-button
          >
        </template>
        <template v-else>
          <p>Complete the payment in the {{ order.gateway }} window, then tap below.</p>
          <ion-button v-if="checkoutUrl" expand="block" :href="checkoutUrl" target="_blank"
            >Open {{ order.gateway }}</ion-button
          >
          <ion-button
            expand="block"
            fill="outline"
            :disabled="busy"
            @click="refreshPayment(order.paymentId, true)"
            >I've paid, check status</ion-button
          >
        </template>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardSubtitle,
  IonCardTitle,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonModal,
  IonRadio,
  IonRadioGroup,
  IonSegment,
  IonSegmentButton,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToolbar,
} from '@ionic/vue';
import { downloadOutline, logoWhatsapp } from 'ionicons/icons';
import type { CheckoutOrderDto, FeeAccountDto, MyFeesDto, PaymentGatewayKey } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { rupees } from '../hr/api';
import { MODE_LABELS, STATUS_COLORS, feesApi, openSigned, toPaise } from './api';

const data = ref<MyFeesDto | null>(null);
const studentId = ref<number | undefined>(undefined);
const payFor = ref<FeeAccountDto | null>(null);
const payChoice = ref<'next' | 'full' | 'custom'>('next');
const customAmount = ref('');
const gateway = ref<PaymentGatewayKey | undefined>(undefined);
const order = ref<CheckoutOrderDto | null>(null);
const busy = ref(false);

const nextDue = computed(() => {
  const i = payFor.value?.instalments?.find((x) => x.balance > 0);
  return i ? i.balance : 0;
});
const payAmount = computed(() =>
  payChoice.value === 'custom'
    ? toPaise(customAmount.value || 0)
    : payChoice.value === 'next' && nextDue.value
      ? nextDue.value
      : (payFor.value?.balance ?? 0),
);
const checkoutUrl = computed(() => {
  const u = order.value?.checkout.url;
  return typeof u === 'string' ? u : undefined;
});

async function load() {
  try {
    data.value = await feesApi.my(studentId.value);
    studentId.value = data.value.student.id;
  } catch (e) {
    void toastError(e);
  }
}

async function switchStudent(v: unknown) {
  studentId.value = Number(v);
  await load();
}

function startPay(a: FeeAccountDto) {
  payFor.value = a;
  payChoice.value = a.instalments?.some((x) => x.balance > 0) ? 'next' : 'full';
  customAmount.value = '';
  gateway.value = data.value?.gateways[0];
  order.value = null;
}

function closePay() {
  payFor.value = null;
  order.value = null;
}

async function checkout() {
  if (!payFor.value) return;
  if (payAmount.value <= 0) {
    void toastError(new Error('Enter an amount'));
    return;
  }
  busy.value = true;
  try {
    order.value = await feesApi.myCheckout({
      accountId: payFor.value.id,
      amount: payAmount.value,
      gateway: gateway.value,
    });
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

async function complete(outcome: 'success' | 'failed') {
  if (!order.value) return;
  busy.value = true;
  try {
    const r = await feesApi.myMockComplete(order.value.paymentId, outcome);
    if (r.payment.status === 'successful') {
      await toast(`Payment successful. Receipt ${r.payment.receiptNumber ?? ''}`);
      closePay();
    } else {
      await toast('Payment failed. You can try again.', 'danger');
      order.value = null;
    }
    await load();
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

async function refreshPayment(id: number, closeOnSuccess = false) {
  busy.value = true;
  try {
    const r = await feesApi.mySync(id);
    await toast(`Payment ${r.payment.status}`, r.payment.status === 'successful' ? 'success' : 'medium');
    if (closeOnSuccess && r.payment.status === 'successful') closePay();
    await load();
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

const pdf = async (id: number) => {
  try {
    openSigned(await feesApi.myReceiptPdf(id));
  } catch (e) {
    void toastError(e);
  }
};
const share = async (id: number) => {
  try {
    await feesApi.myShareReceipt(id);
    await toast('Receipt sent to your WhatsApp');
  } catch (e) {
    void toastError(e);
  }
};

onMounted(load);
</script>
