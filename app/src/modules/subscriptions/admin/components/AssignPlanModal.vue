<template>
  <ion-modal :is-open="open" @did-dismiss="emit('close')">
    <ion-header>
      <ion-toolbar>
        <ion-title>Assign plan</ion-title>
        <ion-buttons slot="end"><ion-button @click="emit('close')">Close</ion-button></ion-buttons>
      </ion-toolbar>
    </ion-header>
    <ion-content class="ion-padding">
      <p class="muted">
        Replaces the current subscription immediately, without an invoice. Its unpaid renewal and plan-change
        invoices are voided; add-ons carry over.
      </p>
      <form @submit.prevent="save">
        <ion-list>
          <ion-item>
            <ion-select v-model="planId" label="Plan" label-placement="stacked" interface="popover">
              <ion-select-option v-for="p in choices" :key="p.id" :value="p.id"
                >{{ p.name }}{{ p.isActive ? '' : ' (inactive)' }}</ion-select-option
              >
            </ion-select>
          </ion-item>
          <ion-item>
            <ion-select v-model="status" label="Status" label-placement="stacked" interface="popover">
              <ion-select-option value="active">Active (paid)</ion-select-option>
              <ion-select-option value="trial">Free trial</ion-select-option>
            </ion-select>
          </ion-item>
          <ion-item>
            <ion-select v-model="cycle" label="Billing cycle" label-placement="stacked" interface="popover">
              <ion-select-option value="monthly">Monthly</ion-select-option>
              <ion-select-option value="yearly">Yearly</ion-select-option>
            </ion-select>
          </ion-item>
          <ion-item>
            <ion-toggle v-model="openEnded">No end date (managed by the platform team)</ion-toggle>
          </ion-item>
          <ion-item v-if="!openEnded">
            <ion-input
              v-model="endsOn"
              :label="status === 'trial' ? 'Trial ends on' : 'Current period ends on'"
              label-placement="stacked"
              type="date"
              :min="tomorrow"
              required
            />
          </ion-item>
        </ion-list>
        <p v-if="openEnded" class="small muted">
          Open-ended subscriptions never lapse or renew, and the institute cannot change its plan or buy
          add-ons itself.
        </p>
        <ion-button expand="block" type="submit" :disabled="busy || !valid">Assign</ion-button>
      </form>
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
  IonInput,
  IonItem,
  IonList,
  IonModal,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToggle,
  IonToolbar,
} from '@ionic/vue';
import type { BillingCycle, PlanDto, SubscriptionDto } from '@erp/shared';
import { toast, toastError } from '@/core/toast';
import { billingAdminApi } from '../../api';

const props = defineProps<{
  open: boolean;
  instituteId: number;
  plans: PlanDto[];
  current: SubscriptionDto | null;
}>();
const emit = defineEmits<{ close: []; done: [] }>();

const planId = ref(0);
const status = ref<'active' | 'trial'>('active');
const cycle = ref<BillingCycle>('monthly');
const openEnded = ref(false);
const endsOn = ref('');
const busy = ref(false);

const isoDay = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const tomorrow = computed(() => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return isoDay(d);
});
const choices = computed(() => props.plans.filter((p) => p.isActive || p.id === props.current?.planId));
const valid = computed(() => planId.value > 0 && (openEnded.value || endsOn.value >= tomorrow.value));

function defaultEnd() {
  const d = new Date();
  if (status.value === 'trial')
    d.setDate(d.getDate() + (props.plans.find((p) => p.id === planId.value)?.trialDays || 14));
  else if (cycle.value === 'yearly') d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return isoDay(d);
}

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    planId.value = props.current?.planId ?? choices.value[0]?.id ?? 0;
    status.value = 'active';
    cycle.value = props.current?.billingCycle ?? 'monthly';
    openEnded.value = false;
    endsOn.value = defaultEnd();
  },
);
watch([status, cycle, planId], () => {
  if (props.open) endsOn.value = defaultEnd();
});

async function save() {
  if (!valid.value) return;
  busy.value = true;
  try {
    await billingAdminApi.assignPlan(props.instituteId, {
      planId: planId.value,
      status: status.value,
      billingCycle: cycle.value,
      // The end of the chosen day, in the admin's time zone.
      endsAt: openEnded.value ? null : new Date(`${endsOn.value}T23:59:59`).toISOString(),
    });
    await toast('Plan assigned');
    emit('done');
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.small {
  font-size: 13px;
}
</style>
