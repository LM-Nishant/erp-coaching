<template>
  <AppPage title="Marketplace refunds" back-href="/admin/marketplace/payouts" :on-refresh="load">
    <ion-segment :value="status" class="filter" @ion-change="setStatus(String($event.detail.value))">
      <ion-segment-button value="requested"><ion-label>Requested</ion-label></ion-segment-button>
      <ion-segment-button value="refunded"><ion-label>Refunded</ion-label></ion-segment-button>
      <ion-segment-button value="failed"><ion-label>Failed</ion-label></ion-segment-button>
      <ion-segment-button value="rejected"><ion-label>Rejected</ion-label></ion-segment-button>
      <ion-segment-button value="all"><ion-label>All</ion-label></ion-segment-button>
    </ion-segment>

    <ion-card v-for="r in page?.items ?? []" :key="r.id" :data-testid="`refund-${r.id}`">
      <ion-card-content>
        <div class="row">
          <div>
            <h3>{{ r.orderNumber }} · {{ r.courseTitle ?? 'Whole order' }}</h3>
            <p>
              {{ r.buyer.name }}<template v-if="r.buyer.mobile"> · {{ r.buyer.mobile }}</template> ·
              {{ REFUND_INITIATOR_LABELS[r.initiatedBy] }} · {{ dateLabel(r.createdAt) }}
            </p>
          </div>
          <div class="amount">
            <strong>{{ rupees(r.amountPaise) }}</strong>
            <ion-badge :color="REFUND_STATUS_COLORS[r.status]">{{
              MKT_REFUND_STATUS_LABELS[r.status]
            }}</ion-badge>
          </div>
        </div>
        <p>“{{ r.reason }}”</p>
        <p v-if="r.decisionNote" class="muted">Note: {{ r.decisionNote }}</p>
        <p v-if="r.gatewayRefundId" class="muted">Gateway refund {{ r.gatewayRefundId }}</p>
        <div v-if="r.status === 'requested'" class="actions">
          <ion-button size="small" :disabled="busy" :data-testid="`approve-${r.id}`" @click="approve(r)"
            >Approve &amp; refund</ion-button
          >
          <ion-button size="small" fill="outline" color="danger" :disabled="busy" @click="reject(r)"
            >Reject</ion-button
          >
        </div>
        <div v-else-if="r.status === 'failed'" class="actions">
          <ion-button size="small" :disabled="busy" :data-testid="`retry-${r.id}`" @click="retry(r)"
            >Retry refund</ion-button
          >
        </div>
      </ion-card-content>
    </ion-card>
    <p v-if="page && !page.items.length" class="muted">No refunds here.</p>
    <div v-if="page && page.total > page.pageSize" class="pager">
      <ion-button fill="clear" :disabled="page.page <= 1" @click="go(page.page - 1)">Previous</ion-button>
      <span>Page {{ page.page }} of {{ Math.ceil(page.total / page.pageSize) }}</span>
      <ion-button fill="clear" :disabled="page.page * page.pageSize >= page.total" @click="go(page.page + 1)"
        >Next</ion-button
      >
    </div>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  IonBadge,
  IonButton,
  IonCard,
  IonCardContent,
  IonLabel,
  IonSegment,
  IonSegmentButton,
} from '@ionic/vue';
import {
  MKT_REFUND_STATUS_LABELS,
  MKT_REFUND_STATUSES,
  type MktPage,
  type MktRefundDto,
  type MktRefundStatus,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { rupees } from '../api';
import {
  REFUND_INITIATOR_LABELS,
  REFUND_STATUS_COLORS,
  dateLabel,
  payoutAdminApi,
  refundOutcome,
} from '../payouts-api';
import { confirmAction, promptText } from './prompt';

const status = ref<MktRefundStatus | 'all'>('requested');
const page = ref<MktPage<MktRefundDto> | null>(null);
const busy = ref(false);

async function go(n = 1) {
  try {
    page.value = await payoutAdminApi.refunds({
      ...(status.value === 'all' ? {} : { status: status.value }),
      page: n,
    });
  } catch (e) {
    void toastError(e);
  }
}
const load = () => go(page.value?.page ?? 1);

function setStatus(v: string) {
  status.value = (MKT_REFUND_STATUSES as readonly string[]).includes(v) ? (v as MktRefundStatus) : 'all';
  void go(1);
}

async function run(fn: () => Promise<MktRefundDto>, done?: string) {
  busy.value = true;
  try {
    const r = await fn();
    const outcome = done ? { message: done, color: 'success' as const } : refundOutcome(r);
    await toast(outcome.message, outcome.color);
    await load();
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

async function approve(r: MktRefundDto) {
  const ok = await confirmAction(
    'Approve refund',
    `Refund ${rupees(r.amountPaise)} to ${r.buyer.name}. Their access to the course is removed and the seller's earnings are reversed.`,
    'Refund',
  );
  if (ok) await run(() => payoutAdminApi.approveRefund(r.id));
}

async function retry(r: MktRefundDto) {
  const ok = await confirmAction(
    'Retry refund',
    `Send the refund of ${rupees(r.amountPaise)} to the payment gateway again. It uses the same refund reference, so it is never paid twice.`,
    'Retry',
  );
  if (ok) await run(() => payoutAdminApi.retryRefund(r.id));
}

async function reject(r: MktRefundDto) {
  const note = await promptText('Reject refund', {
    message: 'The learner sees this note.',
    placeholder: 'Reason',
    confirm: 'Reject',
  });
  if (note) await run(() => payoutAdminApi.rejectRefund(r.id, note), 'Refund rejected');
}

onMounted(() => go(1));
</script>

<style scoped>
.filter {
  max-width: 680px;
  margin-bottom: 8px;
}
.row {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
}
.row h3 {
  margin: 0 0 4px;
}
.amount {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}
.actions,
.pager {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}
.muted {
  color: var(--ion-color-medium);
}
</style>
