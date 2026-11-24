<template>
  <AppPage :title="t('fees.my.title')" :on-refresh="load">
    <ion-segment
      v-if="(data?.students.length ?? 0) > 1"
      :value="studentId"
      scrollable
      @ion-change="switchStudent($event.detail.value)"
    >
      <ion-segment-button v-for="s in data?.students" :key="s.id" :value="s.id">{{
        s.name
      }}</ion-segment-button>
    </ion-segment>

    <template v-if="data">
      <!-- Hero: how much, by when, and one button to pay (or where to pay when online payment is off). -->
      <ion-card class="hero" :class="{ clear: !data.totalDue }">
        <ion-card-header>
          <ion-card-subtitle>{{ data.student.name }} · {{ data.student.admissionNumber }}</ion-card-subtitle>
          <ion-card-title>{{
            data.totalDue ? t('fees.my.due', { amount: formatMoney(data.totalDue) }) : t('fees.my.allPaid')
          }}</ion-card-title>
        </ion-card-header>
        <ion-card-content>
          <template v-if="next">
            <p class="next">
              {{
                t('fees.my.next', {
                  amount: formatMoney(next.instalment.balance),
                  date: formatDate(next.instalment.dueDate),
                })
              }}
              <StatusChip
                :label="t(`fees.my.state.${nextState}`)"
                :tone="STATE_TONE[nextState!]"
                class="chip"
              />
            </p>
            <p v-if="overdueTotal" class="danger-text">
              {{ t('fees.my.overdueNote', { amount: formatMoney(overdueTotal) }) }}
            </p>
          </template>
          <p v-else-if="!data.totalDue" class="muted">{{ t('fees.my.allPaidHint') }}</p>
          <ion-button
            v-if="next && data.gateways.length && payable.length === 1"
            v-can="'my-fees.create'"
            expand="block"
            class="pay"
            @click="startPay(next.account)"
            >{{ t('fees.my.payOnline') }}</ion-button
          >
        </ion-card-content>
      </ion-card>

      <ion-card v-if="data.totalDue && !data.gateways.length" class="office">
        <ion-card-header>
          <ion-card-title>{{ t('fees.my.office.title') }}</ion-card-title>
        </ion-card-header>
        <ion-card-content>
          <p>{{ t('fees.my.office.message', { name: data.office?.name ?? '' }) }}</p>
          <p v-if="data.office?.address" class="muted">{{ data.office.address }}</p>
          <div class="office-actions">
            <ion-button v-if="data.office?.phone" :href="telLink(data.office.phone)" fill="solid">
              <ion-icon slot="start" :icon="callOutline" />{{ t('fees.my.office.call') }}
            </ion-button>
            <ion-button v-if="data.office?.email" :href="`mailto:${data.office.email}`" fill="outline">
              <ion-icon slot="start" :icon="mailOutline" />{{ t('fees.my.office.email') }}
            </ion-button>
          </div>
        </ion-card-content>
      </ion-card>

      <ion-card v-for="a in data.accounts" :key="a.id">
        <ion-card-header>
          <ion-card-subtitle>{{ a.title }}</ion-card-subtitle>
          <ion-card-title
            >{{ formatMoney(a.balance) }}
            <small class="muted">{{
              t('fees.my.ofTotal', { amount: formatMoney(a.net) })
            }}</small></ion-card-title
          >
        </ion-card-header>
        <ion-card-content>
          <ion-list lines="inset">
            <ion-item v-for="i in a.instalments ?? []" :key="i.id">
              <ion-label>
                <h3>{{ i.label }}</h3>
                <p>
                  {{ t('fees.my.dueOn', { date: formatDate(i.dueDate) }) }} ·
                  {{ formatMoney(i.amount + i.lateFee)
                  }}<span v-if="i.lateFee">
                    ({{ t('fees.my.lateFee', { amount: formatMoney(i.lateFee) }) }})</span
                  >
                </p>
              </ion-label>
              <StatusChip
                slot="end"
                :label="t(`fees.my.state.${instalmentState(i)}`)"
                :tone="STATE_TONE[instalmentState(i)]"
              />
            </ion-item>
            <ion-item v-if="a.discount">
              <ion-label class="muted">{{
                t('fees.my.concessions', { amount: formatMoney(a.discount) })
              }}</ion-label>
            </ion-item>
          </ion-list>
          <ion-button
            v-if="payable.length > 1 && payable.includes(a)"
            v-can="'my-fees.create'"
            expand="block"
            fill="outline"
            @click="startPay(a)"
            >{{ t('fees.my.payThis') }}</ion-button
          >
        </ion-card-content>
      </ion-card>

      <ion-list>
        <ion-list-header>{{ t('fees.my.payments') }}</ion-list-header>
        <ion-item v-for="p in data.payments" :key="p.id">
          <ion-label>
            <h3>{{ formatMoney(p.amount) }} · {{ t(`fees.my.mode.${p.mode}`) }}</h3>
            <p>
              {{ formatDate(p.paidOn ?? p.createdAt)
              }}<span v-if="p.receiptNumber"> · {{ p.receiptNumber }}</span>
            </p>
          </ion-label>
          <StatusChip
            slot="end"
            :label="t(`fees.my.paymentStatus.${p.status}`)"
            :tone="PAYMENT_TONE[p.status] ?? 'medium'"
          />
          <ion-buttons v-if="p.receiptId" slot="end">
            <ion-button
              :title="t('fees.my.downloadReceipt')"
              :aria-label="t('fees.my.downloadReceipt')"
              @click="pdf(p.receiptId)"
              ><ion-icon slot="icon-only" :icon="downloadOutline"
            /></ion-button>
            <ion-button
              :title="t('fees.my.sendWhatsapp')"
              :aria-label="t('fees.my.sendWhatsapp')"
              @click="share(p.receiptId)"
              ><ion-icon slot="icon-only" :icon="logoWhatsapp"
            /></ion-button>
          </ion-buttons>
          <ion-button
            v-else-if="p.status === 'pending' && p.mode === 'online'"
            slot="end"
            fill="clear"
            @click="refreshPayment(p.id)"
            >{{ t('fees.my.checkStatus') }}</ion-button
          >
        </ion-item>
        <ion-item v-if="!data.payments.length"
          ><ion-label class="muted">{{ t('fees.my.noPayments') }}</ion-label></ion-item
        >
      </ion-list>
    </template>

    <!-- The gateway's checkout opens outside the modal: it must be able to take focus. -->
    <ion-modal :is-open="!!payFor" :focus-trap="!vendorOpen" @did-dismiss="closePay">
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
                <ion-radio value="next">Next instalment · {{ formatMoney(nextDue) }}</ion-radio>
              </ion-item>
              <ion-item
                ><ion-radio value="full"
                  >Full balance · {{ formatMoney(payFor.balance) }}</ion-radio
                ></ion-item
              >
              <ion-item><ion-radio value="custom">Other amount</ion-radio></ion-item>
            </ion-radio-group>
            <ion-item v-if="payChoice === 'custom'">
              <ion-input v-model="customAmount" type="number" label="Amount (₹)" label-placement="stacked" />
            </ion-item>
            <ion-item v-if="(data?.gateways.length ?? 0) > 1">
              <ion-select v-model="gateway" label="Pay with" label-placement="stacked">
                <ion-select-option v-for="g in data?.gateways" :key="g" :value="g">{{
                  GATEWAY_LABELS[g] ?? g
                }}</ion-select-option>
              </ion-select>
            </ion-item>
          </ion-list>
          <ion-button expand="block" :disabled="busy" @click="checkout"
            >Proceed to pay {{ formatMoney(payAmount) }}</ion-button
          >
        </template>
        <template v-else-if="order.gateway === 'mock'">
          <p class="muted">Test gateway. No real money moves. Choose how this checkout ends.</p>
          <h2>{{ formatMoney(order.amount) }}</h2>
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
          <p>
            Pay in the {{ GATEWAY_LABELS[order.gateway] ?? order.gateway }} checkout. If it closed before you
            finished, open it again.
          </p>
          <ion-button expand="block" :disabled="busy || vendorOpen" @click="launch(order)"
            >Open {{ GATEWAY_LABELS[order.gateway] ?? order.gateway }}</ion-button
          >
          <ion-button
            expand="block"
            fill="outline"
            :disabled="busy || vendorOpen"
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
import { useRoute, useRouter } from 'vue-router';
import {
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
import { callOutline, downloadOutline, logoWhatsapp, mailOutline } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import type { CheckoutOrderDto, FeeAccountDto, MyFeesDto, PaymentGatewayKey } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import StatusChip from '@/components/StatusChip.vue';
import { formatDate, formatMoney } from '@/core/format';
import {
  checkoutReturnTo,
  openCheckout,
  settlePayment,
  takeReturnedPayment,
  withoutReturnQuery,
  type CheckoutOutcome,
} from '@/core/payment-checkout';
import { toast, toastError } from '@/core/toast';
import { GATEWAY_LABELS, feesApi, openSigned, toPaise } from './api';
import { STATE_TONE, instalmentState, nextInstalment, telLink } from './my-fees';

/** App route the gateway's checkout returns to. */
const RETURN_PATH = '/my-fees';

const route = useRoute();
const router = useRouter();
const { t } = useI18n();

const PAYMENT_TONE: Record<string, 'success' | 'warning' | 'danger' | 'medium'> = {
  successful: 'success',
  pending: 'warning',
  failed: 'danger',
};

const data = ref<MyFeesDto | null>(null);
const studentId = ref<number | undefined>(Number(route.query.student) || undefined);
const payFor = ref<FeeAccountDto | null>(null);
const payChoice = ref<'next' | 'full' | 'custom'>('next');
const customAmount = ref('');
const gateway = ref<PaymentGatewayKey | undefined>(undefined);
const order = ref<CheckoutOrderDto | null>(null);
const busy = ref(false);
/** The gateway's checkout is open over the page. */
const vendorOpen = ref(false);

/** Accounts that can be paid online now. */
const payable = computed(() =>
  data.value?.gateways.length
    ? data.value.accounts.filter((a) => a.balance > 0 && a.status === 'active')
    : [],
);
const next = computed(() => (data.value ? nextInstalment(data.value.accounts) : null));
const nextState = computed(() => (next.value ? instalmentState(next.value.instalment) : null));
const overdueTotal = computed(() =>
  (data.value?.accounts ?? [])
    .flatMap((a) => a.instalments ?? [])
    .filter((i) => instalmentState(i) === 'overdue')
    .reduce((sum, i) => sum + i.balance, 0),
);

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
  let o: CheckoutOrderDto;
  try {
    o = await feesApi.myCheckout({
      accountId: payFor.value.id,
      amount: payAmount.value,
      gateway: gateway.value,
      returnTo: checkoutReturnTo(RETURN_PATH),
    });
  } catch (e) {
    void toastError(e);
    return;
  } finally {
    busy.value = false;
  }
  order.value = o;
  if (o.gateway !== 'mock') await launch(o);
}

/** Opens the gateway's checkout. Only the API's check with the gateway decides how the payment ended. */
async function launch(o: CheckoutOrderDto) {
  vendorOpen.value = true;
  let outcome: CheckoutOutcome;
  try {
    outcome = await openCheckout({ paymentId: o.paymentId, path: RETURN_PATH, checkout: o.checkout });
  } catch (e) {
    void toastError(e);
    return;
  } finally {
    vendorOpen.value = false;
  }
  if (outcome !== 'away') await settle(o.paymentId, outcome === 'completed');
}

/**
 * Checks a payment with the gateway. After a completed checkout or a return from the gateway (`wait`) it keeps checking
 * for a few seconds and also reports a payment that is still pending; after a dismissed checkout it checks once.
 */
async function settle(id: number, wait: boolean) {
  busy.value = true;
  try {
    const { payment } = wait
      ? await settlePayment(
          () => feesApi.mySync(id),
          (r) => r.payment.status === 'pending',
        )
      : await feesApi.mySync(id);
    if (payment.status === 'successful') {
      await toast(`Payment successful. Receipt ${payment.receiptNumber ?? ''}`);
      closePay();
    } else if (payment.status === 'failed') {
      await toast('Payment failed. You can try again.', 'danger');
      if (order.value?.paymentId === id) order.value = null;
    } else if (payment.status !== 'pending') {
      await toast(`Payment ${payment.status.replace('_', ' ')}`, 'medium');
    } else if (wait) {
      await toast('The payment is still pending. Check again in a moment.', 'medium');
    }
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
  await load();
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

onMounted(async () => {
  const returned = takeReturnedPayment(RETURN_PATH, route.query);
  if (route.query.payment !== undefined) await router.replace({ query: withoutReturnQuery(route.query) });
  await load();
  if (returned) await settle(returned, true);
});
</script>

<style scoped>
.hero {
  border-left: 4px solid var(--ion-color-warning);
}
.hero.clear {
  border-left-color: var(--ion-color-success);
}
.hero ion-card-title {
  font-size: 1.6rem;
  font-weight: 700;
}
.next {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 1rem;
  color: var(--ion-text-color);
}
.danger-text {
  color: var(--ion-color-danger);
  margin-top: 6px;
}
.pay {
  margin-top: 12px;
  min-height: var(--app-tap-target, 48px);
}
.office-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
small.muted {
  font-size: 0.85rem;
  font-weight: 400;
}
</style>
