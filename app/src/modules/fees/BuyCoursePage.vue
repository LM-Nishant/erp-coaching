<template>
  <AppPage title="Buy course" back-href="/my-fees">
    <ion-card v-if="quote">
      <ion-card-header>
        <ion-card-title>{{ quote.courseName }}</ion-card-title>
      </ion-card-header>
      <ion-card-content>
        <template v-if="quote.alreadyPaid">
          <p>You already have access to this course.</p>
          <div class="notice" :class="enrolmentNote.color">
            <ion-icon :icon="enrolmentNote.color === 'warning' ? timeOutline : informationCircleOutline" />
            <span>{{ enrolmentNote.text }}</span>
          </div>
        </template>
        <template v-else-if="!order">
          <ion-list>
            <ion-item v-if="!quote.batchFixed && batchChoices.length">
              <ion-select
                :value="shownBatchId"
                label="Batch"
                label-placement="stacked"
                :disabled="busy"
                @ion-change="pickBatch(Number($event.detail.value))"
              >
                <ion-select-option :value="0">No preference</ion-select-option>
                <ion-select-option
                  v-for="b in batchChoices"
                  :key="b.id"
                  :value="b.id"
                  :disabled="b.disabled"
                  >{{ b.label }}</ion-select-option
                >
              </ion-select>
            </ion-item>
            <ion-item v-else-if="quote.batch">
              <ion-label>Batch</ion-label>
              <ion-note slot="end">{{ quote.batch.name ?? 'Chosen batch' }}</ion-note>
            </ion-item>
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
          <div v-if="batchNote" class="notice" :class="batchNote.color">
            <ion-icon :icon="batchNote.color === 'warning' ? alertCircleOutline : informationCircleOutline" />
            <span>{{ batchNote.text }}</span>
          </div>
          <ion-button expand="block" :disabled="busy || quote.payable <= 0 || batchBlocked" @click="checkout"
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
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonSelect,
  IonSelectOption,
} from '@ionic/vue';
import { alertCircleOutline, informationCircleOutline, timeOutline } from 'ionicons/icons';
import { COURSE_BATCH_ISSUE_LABELS, type CheckoutOrderDto, type CourseQuoteDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { rupees } from '../hr/api';
import { batchOptionLabel, feesApi } from './api';

const route = useRoute();
const router = useRouter();
const courseId = Number(route.params.courseId);
const qs = (k: string) => (typeof route.query[k] === 'string' ? (route.query[k] as string) : undefined);
/** The batch the buyer picked (0: no preference; an earlier unpaid purchase then keeps its batch). */
const picked = ref(Number(qs('batchId')) || 0);
const referralCode = qs('ref');
const coupon = ref(qs('coupon') ?? '');
const quote = ref<CourseQuoteDto | null>(null);
const order = ref<CheckoutOrderDto | null>(null);
const busy = ref(false);
const checkoutUrl = computed(() => {
  const u = order.value?.checkout.url;
  return typeof u === 'string' ? u : undefined;
});

const shownBatchId = computed(() => picked.value || quote.value?.batch?.id || 0);
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const batchChoices = computed(() => {
  const q = quote.value;
  if (!q) return [];
  const choices = q.openBatches.map((b) => ({ id: b.id, label: batchOptionLabel(b), disabled: false }));
  const chosen = q.batch;
  if (chosen && !choices.some((c) => c.id === chosen.id))
    choices.unshift({
      id: chosen.id,
      label: `${chosen.name ?? 'Chosen batch'} · ${chosen.available ? 'available' : 'unavailable'}`,
      disabled: !chosen.available,
    });
  return choices;
});

/** A batch the buyer picked that cannot take them: checkout would be refused. */
const batchBlocked = computed(() => {
  const b = quote.value?.batch;
  return !!picked.value && !!b && !b.available && !quote.value?.batchFixed;
});

const batchNote = computed<{ color: 'warning' | 'medium'; text: string } | null>(() => {
  const q = quote.value;
  if (!q) return null;
  if (q.batch && !q.batch.available) {
    const issue = sentence(COURSE_BATCH_ISSUE_LABELS[q.batch.reason ?? 'closed']);
    return batchBlocked.value
      ? { color: 'warning', text: `${issue}. Pick another batch, or "No preference".` }
      : {
          color: 'warning',
          text: `${issue}. You can still pay; the institute will place you in another batch of the course.`,
        };
  }
  if (!q.batch && !q.openBatches.length)
    return {
      color: 'medium',
      text: 'No batch of this course has a free seat right now. You can still pay; the institute will assign you a batch and let you know.',
    };
  return null;
});

const enrolmentNote = computed<{ color: 'warning' | 'medium'; text: string }>(() => {
  const e = quote.value?.enrolment;
  if (e?.status === 'enrolled')
    return {
      color: 'medium',
      text: e.batchName ? `You are enrolled in ${e.batchName}.` : 'You are enrolled.',
    };
  if (e?.status === 'awaiting_batch')
    return {
      color: 'warning',
      text: 'Your admission is confirmed. The institute will assign you a batch and let you know.',
    };
  return { color: 'medium', text: 'Your admission is being set up. Check back in a few minutes.' };
});

async function load() {
  busy.value = true;
  try {
    const q = { coupon: coupon.value.trim() || undefined };
    let next = await feesApi.courseQuote(courseId, { ...q, batchId: picked.value || undefined });
    // A part-paid or batch-priced purchase keeps its batch: show that one instead of the pick.
    if (next.batchFixed && picked.value) {
      picked.value = 0;
      next = await feesApi.courseQuote(courseId, q);
    }
    quote.value = next;
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

function pickBatch(id: number) {
  if (id === shownBatchId.value) return;
  picked.value = id;
  void load();
}

async function checkout() {
  busy.value = true;
  try {
    const valid = quote.value?.coupon?.valid;
    order.value = await feesApi.courseCheckout(courseId, {
      batchId: picked.value || undefined,
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
