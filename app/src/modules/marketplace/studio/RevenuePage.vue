<template>
  <AppPage title="Revenue" :back-href="`/market/studio/${scope}`" :on-refresh="load">
    <template #actions>
      <ion-button :router-link="`/market/studio/${scope}/payouts`" data-testid="open-payouts"
        >Payouts</ion-button
      >
    </template>

    <ion-card v-if="data && !data.hasPayoutAccount" class="notice">
      <ion-card-content>
        <strong>Add your payout details</strong> so we can send your earnings.
        <ion-button
          size="small"
          fill="solid"
          data-testid="add-payout-account"
          :router-link="`/market/studio/${scope}/payout-account`"
          >Add bank or UPI</ion-button
        >
      </ion-card-content>
    </ion-card>

    <section v-if="data" aria-label="Balance">
      <div class="cards balance">
        <StatCard
          label="Next payout (pending)"
          :value="signedRupees(data.balance.pendingPaise)"
          :hint="
            data.balance.onHoldPaise
              ? `${signedRupees(data.balance.onHoldPaise)} still in the ${data.settings.holdDays}-day refund window`
              : `Paid monthly once over ${rupees(data.settings.minPayoutPaise)}`
          "
          data-testid="balance-pending"
        />
        <StatCard
          label="Being paid"
          :value="signedRupees(data.balance.processingPaise)"
          hint="In this month's payout run"
        />
        <StatCard
          label="Paid to you"
          :value="signedRupees(data.balance.paidPaise)"
          :hint="
            data.balance.lastPaidAt ? `Last payout ${dateLabel(data.balance.lastPaidAt)}` : 'No payouts yet'
          "
          data-testid="balance-paid"
        />
      </div>
    </section>

    <div class="toolbar">
      <ion-segment :value="range" @ion-change="setRange(String($event.detail.value))">
        <ion-segment-button value="12m"><ion-label>12 months</ion-label></ion-segment-button>
        <ion-segment-button value="30d"><ion-label>30 days</ion-label></ion-segment-button>
      </ion-segment>
    </div>

    <template v-if="data">
      <div class="cards">
        <StatCard label="Sales" :value="rupees(data.totals.grossPaise)" :hint="`${data.totals.sales} sold`" />
        <StatCard label="Platform commission" :value="rupees(data.totals.commissionPaise)" />
        <StatCard label="Your earnings" :value="rupees(data.totals.netPaise)" data-testid="revenue-net" />
        <StatCard
          label="Refunds"
          :value="rupees(data.totals.refundedPaise)"
          :hint="`${data.totals.refunds} refunded`"
        />
      </div>

      <section class="chart" aria-label="Earnings over time">
        <h3>Earnings over time</h3>
        <div class="bars" role="img" :aria-label="chartSummary">
          <div
            v-for="(p, i) in data.series"
            :key="p.period"
            class="bar-col"
            :title="`${p.period}: ${signedRupees(p.netPaise)}`"
          >
            <div class="bar-area">
              <div
                class="bar"
                :class="{ negative: p.netPaise < 0 }"
                :style="{ height: `${Math.round((Math.abs(p.netPaise) / max) * 100)}%` }"
              />
            </div>
            <span class="bar-label">{{ i % labelEvery === 0 ? periodShort(p.period) : '' }}</span>
          </div>
        </div>
      </section>

      <section aria-label="Courses">
        <h3>By course</h3>
        <div class="table-wrap">
          <table v-if="data.courses.length">
            <thead>
              <tr>
                <th>Course</th>
                <th>Enrolments</th>
                <th>Sales</th>
                <th>Refunds</th>
                <th>Sales value</th>
                <th>Your earnings</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in data.courses" :key="c.courseId">
                <td class="title">{{ c.title }}</td>
                <td>{{ c.enrolments }}</td>
                <td>{{ c.sales }}</td>
                <td>{{ c.refunds }}</td>
                <td>{{ signedRupees(c.grossPaise) }}</td>
                <td>{{ signedRupees(c.netPaise) }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="muted">No sales or enrolments in this period.</p>
        </div>
      </section>

      <p class="muted">
        Earnings are what learners paid after coupons, less the platform commission. Each sale can be refunded
        for
        {{ data.settings.refundWindowDays }} days, so it is paid out after {{ data.settings.holdDays }} days,
        in the monthly payout.
        <router-link :to="`/market/studio/${scope}/sales`">See every sale</router-link> ·
        <router-link :to="`/market/studio/${scope}/payout-account`">Payout details</router-link>
      </p>
    </template>
    <div v-else class="center"><ion-spinner /></div>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import {
  IonButton,
  IonCard,
  IonCardContent,
  IonLabel,
  IonSegment,
  IonSegmentButton,
  IonSpinner,
} from '@ionic/vue';
import type { MktRevenueDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import StatCard from '@/components/StatCard.vue';
import { toastError } from '@/core/toast';
import { rupees, type StudioScope } from '../api';
import { dateLabel, payoutStudioApi, periodShort, signedRupees } from '../payouts-api';

const route = useRoute();
const scope = route.params.scope as StudioScope;
const api = payoutStudioApi(scope);
const data = ref<MktRevenueDto | null>(null);
const range = ref<'12m' | '30d'>('12m');

const labelEvery = computed(() => (range.value === '30d' ? 5 : 1));
const max = computed(() => Math.max(1, ...(data.value?.series ?? []).map((p) => Math.abs(p.netPaise))));
const chartSummary = computed(() => {
  const best = [...(data.value?.series ?? [])].sort((a, b) => b.netPaise - a.netPaise)[0];
  return best && best.netPaise > 0
    ? `Earnings by ${range.value === '12m' ? 'month' : 'day'}; best ${best.period} with ${signedRupees(best.netPaise)}`
    : 'No earnings in this period';
});

async function load() {
  try {
    data.value = await api.revenue({ groupBy: range.value === '12m' ? 'month' : 'day' });
  } catch (e) {
    void toastError(e);
  }
}

function setRange(v: string) {
  range.value = v === '30d' ? '30d' : '12m';
  void load();
}

onMounted(load);
</script>

<style scoped>
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 12px;
  margin-bottom: 12px;
}
.notice ion-card-content {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}
.notice {
  margin: 0 0 12px;
  border-left: 4px solid var(--ion-color-warning);
}
.toolbar {
  max-width: 320px;
  margin: 8px 0 12px;
}
.chart {
  margin: 8px 0 16px;
}
.bars {
  display: flex;
  align-items: stretch;
  gap: 4px;
  height: 180px;
  padding: 8px 0;
  overflow-x: auto;
}
.bar-col {
  flex: 1 0 18px;
  display: flex;
  flex-direction: column;
  align-items: center;
  min-width: 18px;
}
.bar-area {
  flex: 1;
  width: 100%;
  display: flex;
  align-items: flex-end;
}
.bar {
  width: 100%;
  min-height: 2px;
  border-radius: 4px 4px 0 0;
  background: var(--ion-color-primary);
}
.bar.negative {
  background: var(--ion-color-danger);
}
.bar-label {
  font-size: 10px;
  color: var(--ion-color-medium);
  white-space: nowrap;
  margin-top: 4px;
}
.table-wrap {
  overflow-x: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}
th,
td {
  text-align: left;
  padding: 8px 6px;
  border-bottom: 1px solid var(--ion-color-light-shade);
  white-space: nowrap;
}
td.title {
  white-space: normal;
  min-width: 180px;
}
.muted {
  color: var(--ion-color-medium);
}
.center {
  display: flex;
  justify-content: center;
  padding: 32px;
}
</style>
