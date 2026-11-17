<template>
  <AppPage title="Buy course" back-href="/my-fees">
    <ion-card v-if="quote">
      <ion-card-header>
        <ion-card-title>{{ quote.courseName }}</ion-card-title>
      </ion-card-header>
      <ion-card-content>
        <p v-if="quote.alreadyPaid">You already have access to this course.</p>
        <template v-else-if="!order">
          <ion-list>
            <ion-item>
              <ion-label>Price</ion-label>
              <ion-note slot="end">{{ rupees(quote.amount) }}</ion-note>
            </ion-item>
            <ion-item v-if="quote.discount">
              <ion-label>Coupon {{ quote.coupon?.code }}</ion-label>
              <ion-note slot="end">- {{ rupees(quote.discount) }}</ion-note>
            </ion-item>
            <ion-item>
              <ion-label><strong>To pay</strong></ion-label>
              <ion-note slot="end">{{ rupees(quote.payable) }}</ion-note>
            </ion-item>
            <ion-item>
              <ion-input v-model="coupon" label="Coupon code" label-placement="stacked" />
              <ion-button slot="end" fill="clear" :disabled="busy" @click="load">Apply</ion-button>
            </ion-item>
          </ion-list>
          <p v-if="quote.coupon && !quote.coupon.valid" class="muted">{{ quote.coupon.message }}</p>
          <ion-button expand="block" :disabled="busy || quote.payable <= 0" @click="checkout"
            >Pay {{ rupees(quote.payable) }}</ion-button
          >
        </template>
        <template v-else-if="order.gateway === 'mock'">
          <p class="muted">Test gateway. No real money moves.</p>
          <h2>{{ rupees(order.amount) }}</h2>
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
          <ion-button expand="block" fill="outline" :disabled="busy" @click="sync"
            >I've paid, check status</ion-button
          >
        </template>
      </ion-card-content>
    </ion-card>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  IonButton,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardTitle,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
} from '@ionic/vue';
import type { CheckoutOrderDto, CourseQuoteDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { rupees } from '../hr/api';
import { feesApi } from './api';

const route = useRoute();
const router = useRouter();
const courseId = Number(route.params.courseId);
const qs = (k: string) => (typeof route.query[k] === 'string' ? (route.query[k] as string) : undefined);
const batchId = qs('batchId') ? Number(qs('batchId')) : undefined;
const referralCode = qs('ref');
const coupon = ref(qs('coupon') ?? '');
const quote = ref<CourseQuoteDto | null>(null);
const order = ref<CheckoutOrderDto | null>(null);
const busy = ref(false);
const checkoutUrl = computed(() => {
  const u = order.value?.checkout.url;
  return typeof u === 'string' ? u : undefined;
});

async function load() {
  busy.value = true;
  try {
    quote.value = await feesApi.courseQuote(courseId, { batchId, coupon: coupon.value.trim() || undefined });
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

async function checkout() {
  busy.value = true;
  try {
    const valid = quote.value?.coupon?.valid;
    order.value = await feesApi.courseCheckout(courseId, {
      batchId,
      couponCode: valid ? quote.value?.coupon?.code : undefined,
      referralCode,
    });
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

async function done(status: string) {
  if (status === 'successful') {
    await toast('Payment successful. Your course is unlocked.');
    await router.replace('/my-fees');
  } else {
    await toast(`Payment ${status}`, 'medium');
    if (status === 'failed') order.value = null;
  }
}

async function complete(outcome: 'success' | 'failed') {
  if (!order.value) return;
  busy.value = true;
  try {
    await done((await feesApi.myMockComplete(order.value.paymentId, outcome)).payment.status);
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

async function sync() {
  if (!order.value) return;
  busy.value = true;
  try {
    await done((await feesApi.mySync(order.value.paymentId)).payment.status);
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>
