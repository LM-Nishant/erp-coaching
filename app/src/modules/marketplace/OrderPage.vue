<template>
  <MarketShell :title="order ? `Order ${order.number}` : 'Order'" back-href="/market/orders" :search="false">
    <template v-if="order">
      <ion-card v-if="order.status === 'pending'" class="pay">
        <ion-card-content>
          <template v-if="order.gateway === 'mock'">
            <p class="muted">Test gateway. No real money moves.</p>
            <h2>{{ rupees(order.totalPaise) }}</h2>
            <ion-button
              expand="block"
              color="success"
              :disabled="busy"
              data-testid="mock-pay"
              @click="mock('success')"
              >Pay now</ion-button
            >
            <ion-button expand="block" fill="outline" color="danger" :disabled="busy" @click="mock('failed')"
              >Simulate failure</ion-button
            >
          </template>
          <template v-else>
            <p>
              Complete the payment in the {{ gatewayName }} checkout. If it closed before you finished, open
              it again.
            </p>
            <ion-button v-if="payment" expand="block" :disabled="busy" @click="launch"
              >Open {{ gatewayName }}</ion-button
            >
            <ion-button expand="block" fill="outline" :disabled="busy" @click="sync(false)"
              >I've paid, check status</ion-button
            >
          </template>
        </ion-card-content>
      </ion-card>
      <ion-card v-else-if="order.status === 'paid'" class="paid" data-testid="order-paid">
        <ion-card-content>
          <h2>Payment successful</h2>
          <p>Your courses are ready in My learning.</p>
          <ion-button router-link="/market/learning">Start learning</ion-button>
        </ion-card-content>
      </ion-card>
      <ion-card v-else-if="order.status === 'refunded'">
        <ion-card-content>
          <h2>Refunded</h2>
          <p>This order was refunded to your original payment method.</p>
        </ion-card-content>
      </ion-card>
      <ion-card v-else>
        <ion-card-content>
          <h2>Payment {{ order.status }}</h2>
          <p>No money was taken for this order. You can try again from your cart.</p>
          <ion-button router-link="/market/cart" fill="outline">Back to cart</ion-button>
        </ion-card-content>
      </ion-card>

      <section class="receipt" aria-label="Receipt">
        <h2>Receipt</h2>
        <div class="line">
          <span>Order</span><span>{{ order.number }}</span>
        </div>
        <div class="line">
          <span>Date</span><span>{{ new Date(order.paidAt ?? order.createdAt).toLocaleString() }}</span>
        </div>
        <div class="line">
          <span>Billed to</span><span>{{ order.buyer.name }}</span>
        </div>
        <div v-if="order.gatewayPaymentId" class="line">
          <span>Payment reference</span><span>{{ order.gatewayPaymentId }}</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Course</th>
              <th>Price</th>
              <th>Paid</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="i in order.items" :key="i.courseId">
              <td>
                <router-link :to="`/market/course/${i.slug}`">{{ i.title }}</router-link>
                <div class="muted">{{ i.sellerName }}</div>
              </td>
              <td>{{ rupees(i.pricePaise) }}</td>
              <td>{{ rupees(i.paidPaise) }}</td>
            </tr>
          </tbody>
        </table>
        <div class="line">
          <span>Subtotal</span><span>{{ rupees(order.subtotalPaise) }}</span>
        </div>
        <div v-if="order.discountPaise" class="line">
          <span>Discount{{ order.couponCode ? ` (${order.couponCode})` : '' }}</span
          ><span>- {{ rupees(order.discountPaise) }}</span>
        </div>
        <div class="line total">
          <span>Total</span><span>{{ rupees(order.totalPaise) }}</span>
        </div>
        <ion-button fill="clear" size="small" @click="print">Print receipt</ion-button>
      </section>
      <RefundPanel v-if="order.status === 'paid' || order.status === 'refunded'" :order="order" />
    </template>
    <div v-else class="center"><ion-spinner /></div>
  </MarketShell>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { IonButton, IonCard, IonCardContent, IonSpinner } from '@ionic/vue';
import type { MktOrderDto } from '@erp/shared';
import {
  openCheckout,
  settlePayment,
  takeReturnedPayment,
  withoutReturnQuery,
} from '@/core/payment-checkout';
import { toast, toastError } from '@/core/toast';
import MarketShell from './components/MarketShell.vue';
import RefundPanel from './components/RefundPanel.vue';
import { marketApi, rupees } from './api';
import { pendingCheckouts } from './checkout-state';
import { useMarketAccount } from './store';

const GATEWAYS: Record<string, string> = {
  razorpay: 'Razorpay',
  paytm: 'Paytm',
  cashfree: 'Cashfree',
  mock: 'test',
};
const route = useRoute();
const router = useRouter();
const { refresh: refreshAccount } = useMarketAccount();
const id = Number(route.params.id);
const order = ref<MktOrderDto | null>(null);
const busy = ref(false);
const payment = computed(() => pendingCheckouts.get(id) ?? null);
const gatewayName = computed(() => GATEWAYS[order.value?.gateway ?? ''] ?? order.value?.gateway ?? 'payment');

async function finished(o: MktOrderDto) {
  order.value = o;
  if (o.status === 'paid') {
    pendingCheckouts.delete(id);
    void refreshAccount();
    await toast('Payment successful. Your courses are unlocked.');
  } else if (o.status === 'failed') await toast('Payment failed', 'medium');
}

async function mock(outcome: 'success' | 'failed') {
  busy.value = true;
  try {
    await finished((await marketApi.mockComplete(id, outcome)).order);
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

async function sync(wait: boolean) {
  busy.value = true;
  try {
    const o = wait
      ? await settlePayment(
          () => marketApi.syncOrder(id),
          (x) => x.status === 'pending',
        )
      : await marketApi.syncOrder(id);
    if (o.status === 'pending')
      await toast('The payment is still pending. Check again in a moment.', 'medium');
    await finished(o);
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

async function launch() {
  if (!payment.value) return;
  try {
    const outcome = await openCheckout({
      paymentId: id,
      path: '/market/orders',
      checkout: payment.value.checkout,
    });
    if (outcome !== 'away') await sync(outcome === 'completed');
  } catch (e) {
    void toastError(e);
  }
}

const print = () => window.print();

onMounted(async () => {
  try {
    order.value = await marketApi.order(id);
  } catch (e) {
    void toastError(e);
    return;
  }
  const returned = takeReturnedPayment('/market/orders', route.query);
  if (returned === id) {
    await router.replace({ query: withoutReturnQuery(route.query) });
    await sync(true);
  } else if (order.value.status === 'pending' && payment.value && order.value.gateway !== 'mock')
    await launch();
});
</script>

<style scoped>
.paid h2 {
  color: var(--ion-color-success-shade);
}
.receipt {
  padding: 8px 16px;
}
.line {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  margin: 6px 0;
}
.total {
  font-weight: 700;
  font-size: 18px;
}
table {
  width: 100%;
  border-collapse: collapse;
  margin: 12px 0;
}
th,
td {
  text-align: left;
  padding: 6px 4px;
  border-bottom: 1px solid var(--ion-color-light-shade);
  vertical-align: top;
}
th:not(:first-child),
td:not(:first-child) {
  text-align: right;
  white-space: nowrap;
}
.muted {
  color: var(--ion-color-medium);
  font-size: 12px;
}
.center {
  text-align: center;
  padding: 40px;
}
</style>
