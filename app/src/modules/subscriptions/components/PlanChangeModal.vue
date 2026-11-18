<template>
  <ion-modal :is-open="open" @did-dismiss="close">
    <ion-header>
      <ion-toolbar>
        <ion-title>Change plan</ion-title>
        <ion-buttons slot="end"><ion-button @click="close">Close</ion-button></ion-buttons>
      </ion-toolbar>
    </ion-header>
    <ion-content class="ion-padding">
      <ion-segment v-model="cycle">
        <ion-segment-button value="monthly"><ion-label>Monthly</ion-label></ion-segment-button>
        <ion-segment-button value="yearly"><ion-label>Yearly</ion-label></ion-segment-button>
      </ion-segment>

      <ion-list>
        <ion-radio-group v-model="planId">
          <ion-item v-for="p in plans" :key="p.id">
            <ion-radio :value="p.id" :disabled="!cycleOffered(p, cycle)" justify="space-between">
              <div class="plan-name">
                {{ p.name }}
                <ion-badge v-if="p.id === currentPlanId" color="light">Current</ion-badge>
              </div>
              <div class="muted small ion-text-wrap">
                <template v-if="cycleOffered(p, cycle)">
                  {{ planPrice(p, cycle) ? rupees(planPrice(p, cycle)) : 'Free' }}
                  {{ cycle === 'yearly' ? 'per year' : 'per month' }}
                </template>
                <template v-else>Not offered with {{ cycle }} billing</template>
                · {{ limitsSummary(p.limits) }}
              </div>
            </ion-radio>
          </ion-item>
        </ion-radio-group>
      </ion-list>

      <ion-card v-if="planId && (preview || previewError || previewing)">
        <ion-card-content>
          <p v-if="previewing" class="muted">Calculating…</p>
          <p v-else-if="previewError" class="danger">{{ previewError }}</p>
          <template v-else-if="preview">
            <p>{{ preview.message }}</p>
            <template v-if="preview.totalPaise > 0">
              <p class="small">
                {{ rupees(preview.subtotalPaise) }} + GST {{ rupees(preview.taxPaise) }} =
                <strong>{{ rupees(preview.totalPaise) }}</strong>
              </p>
            </template>
            <p v-if="preview.periodEnd" class="small muted">
              New term {{ formatDate(preview.periodStart) }} – {{ formatDate(preview.periodEnd) }}
            </p>
            <ion-list v-if="preview.blockedBy.length" lines="none">
              <ion-item v-for="b in preview.blockedBy" :key="b.metric">
                <ion-label class="ion-text-wrap">
                  {{ METRIC_LABELS[b.metric] }}: using {{ formatMetric(b.metric, b.used) }}, the plan allows
                  {{ formatMetric(b.metric, b.limit) }}
                </ion-label>
              </ion-item>
            </ion-list>
          </template>
        </ion-card-content>
      </ion-card>

      <ion-button expand="block" :disabled="!canConfirm || busy" @click="confirm">{{
        confirmLabel
      }}</ion-button>
    </ion-content>
  </ion-modal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonCard,
  IonCardContent,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonModal,
  IonRadio,
  IonRadioGroup,
  IonSegment,
  IonSegmentButton,
  IonTitle,
  IonToolbar,
} from '@ionic/vue';
import {
  METRIC_LABELS,
  type BillingActionResultDto,
  type BillingCycle,
  type BillingOverviewDto,
  type PlanChangePreviewDto,
} from '@erp/shared';
import { errorMessage } from '@/core/api';
import { toastError } from '@/core/toast';
import { rupees } from '@/modules/hr/api';
import { billingApi } from '../api';
import { cycleOffered, formatDate, formatMetric, limitsSummary, planPrice } from '../format';

const props = defineProps<{ open: boolean; overview: BillingOverviewDto }>();
const emit = defineEmits<{ close: []; done: [result: BillingActionResultDto] }>();

const cycle = ref<BillingCycle>('monthly');
const planId = ref<number | null>(null);
const preview = ref<PlanChangePreviewDto | null>(null);
const previewError = ref<string | null>(null);
const previewing = ref(false);
const busy = ref(false);
let previewSeq = 0;

const plans = computed(() => props.overview.plans.filter((p) => p.isActive));
const currentPlanId = computed(() => props.overview.subscription?.planId ?? null);

const canConfirm = computed(
  () =>
    !!preview.value &&
    !previewing.value &&
    preview.value.kind !== 'same' &&
    preview.value.blockedBy.length === 0,
);
const confirmLabel = computed(() => {
  const p = preview.value;
  if (!p || p.kind === 'same') return 'Choose a different plan or cycle';
  if (p.kind === 'upgrade' && p.totalPaise > 0) return `Continue to pay ${rupees(p.totalPaise)}`;
  if (p.kind === 'downgrade' && p.effective === 'period_end') return 'Schedule the change';
  return 'Change plan';
});

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    cycle.value = props.overview.subscription?.billingCycle ?? 'monthly';
    planId.value = null;
    preview.value = null;
    previewError.value = null;
  },
  { immediate: true },
);

watch([planId, cycle], async ([id, c]) => {
  const seq = ++previewSeq;
  preview.value = null;
  previewError.value = null;
  const plan = plans.value.find((p) => p.id === id);
  if (!plan || !cycleOffered(plan, c)) return;
  previewing.value = true;
  try {
    const result = await billingApi.previewPlanChange(plan.id, c);
    if (seq === previewSeq) preview.value = result;
  } catch (e) {
    if (seq === previewSeq) previewError.value = errorMessage(e);
  } finally {
    if (seq === previewSeq) previewing.value = false;
  }
});

function close() {
  if (props.open) emit('close');
}

async function confirm() {
  if (!planId.value || !canConfirm.value) return;
  busy.value = true;
  try {
    emit('done', await billingApi.changePlan(planId.value, cycle.value));
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.plan-name {
  display: flex;
  gap: 8px;
  align-items: center;
  font-weight: 600;
}
.small {
  font-size: 13px;
}
.danger {
  color: var(--ion-color-danger);
}
</style>
