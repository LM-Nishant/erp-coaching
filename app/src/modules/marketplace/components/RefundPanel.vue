<template>
  <section
    v-if="data && (data.requests.length || data.refundableCourseIds.length)"
    class="refunds"
    aria-label="Refunds"
  >
    <h2>Refunds</h2>
    <ion-list v-if="data.requests.length" lines="full">
      <ion-item v-for="r in data.requests" :key="r.id" :data-testid="`refund-${r.id}`">
        <ion-label class="ion-text-wrap">
          <h3>{{ r.courseTitle ?? 'Whole order' }} · {{ rupees(r.amountPaise) }}</h3>
          <p>{{ r.reason }}</p>
          <p v-if="r.decisionNote" class="muted">{{ r.decisionNote }}</p>
        </ion-label>
        <ion-badge slot="end" :color="REFUND_STATUS_COLORS[r.status]">{{
          MKT_REFUND_STATUS_LABELS[r.status]
        }}</ion-badge>
      </ion-item>
    </ion-list>
    <template v-if="data.refundableUntil">
      <p class="muted">
        Not what you expected? You can ask for a refund until {{ dateLabel(data.refundableUntil) }}. Refunded
        courses are removed from My learning.
      </p>
      <ion-button fill="outline" size="small" data-testid="request-refund" @click="open = true"
        >Request a refund</ion-button
      >
    </template>

    <ion-modal :is-open="open" @did-dismiss="open = false">
      <ion-header>
        <ion-toolbar>
          <ion-title>Request a refund</ion-title>
          <ion-buttons slot="end"><ion-button @click="open = false">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <form @submit.prevent="submit">
          <ion-list>
            <ion-item v-if="choices.length > 1">
              <ion-select v-model="courseId" label="Course" label-placement="stacked" interface="popover">
                <ion-select-option :value="0">All courses in this order</ion-select-option>
                <ion-select-option v-for="c in choices" :key="c.courseId" :value="c.courseId">{{
                  c.title
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-textarea
                v-model="reason"
                label="Why do you want a refund?"
                label-placement="stacked"
                :auto-grow="true"
                :maxlength="1000"
                data-testid="refund-reason"
              />
            </ion-item>
          </ion-list>
          <p class="muted">The marketplace team reviews requests, usually within 2 working days.</p>
          <ion-button
            type="submit"
            expand="block"
            :disabled="busy || reason.trim().length < 3"
            data-testid="refund-submit"
            >Send request</ion-button
          >
        </form>
      </ion-content>
    </ion-modal>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonSelect,
  IonSelectOption,
  IonTextarea,
  IonTitle,
  IonToolbar,
} from '@ionic/vue';
import { MKT_REFUND_STATUS_LABELS, type MktOrderDto, type MktOrderRefundsDto } from '@erp/shared';
import { toast, toastError } from '@/core/toast';
import { rupees } from '../api';
import { REFUND_STATUS_COLORS, dateLabel, refundApi } from '../payouts-api';

const props = defineProps<{ order: MktOrderDto }>();
const data = ref<MktOrderRefundsDto | null>(null);
const open = ref(false);
const busy = ref(false);
const reason = ref('');
const courseId = ref(0);
const choices = computed(() =>
  props.order.items.filter((i) => data.value?.refundableCourseIds.includes(i.courseId)),
);

async function load() {
  try {
    data.value = await refundApi.forOrder(props.order.id);
  } catch (e) {
    void toastError(e);
  }
}

async function submit() {
  busy.value = true;
  try {
    const only = choices.value.length === 1 && props.order.items.length > 1 ? choices.value[0].courseId : 0;
    await refundApi.request(props.order.id, {
      courseId: courseId.value || only || null,
      reason: reason.value.trim(),
    });
    open.value = false;
    reason.value = '';
    await toast('Refund requested. We will let you know once it is reviewed.');
    await load();
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.refunds {
  margin: 24px 16px 16px;
}
.muted {
  color: var(--ion-color-medium);
}
</style>
