<template>
  <AppPage
    :title="id ? 'Payout statement' : 'Payouts'"
    :back-href="id ? `/market/studio/${scope}/payouts` : `/market/studio/${scope}/revenue`"
    :on-refresh="load"
  >
    <template v-if="!id">
      <p class="muted">
        Earnings are paid once a month for sales past the refund window.
        <router-link :to="`/market/studio/${scope}/payout-account`">Payout details</router-link>
      </p>
      <ion-list v-if="payouts.length">
        <ion-item
          v-for="p in payouts"
          :key="p.id"
          :router-link="`/market/studio/${scope}/payouts/${p.id}`"
          detail
          :data-testid="`payout-${p.id}`"
        >
          <ion-label>
            <h3>{{ payoutPeriod(p.periodStart, p.periodEnd) }}</h3>
            <p>
              {{ p.entries }} entries
              <template v-if="p.paidAt"> · paid {{ dateLabel(p.paidAt) }} · ref {{ p.reference }}</template>
              <template v-else-if="p.holdReason"> · {{ p.holdReason }}</template>
            </p>
          </ion-label>
          <div slot="end" class="end">
            <strong>{{ signedRupees(p.netPaise) }}</strong>
            <ion-badge :color="PAYOUT_STATUS_COLORS[p.status]">{{
              MKT_PAYOUT_STATUS_LABELS[p.status]
            }}</ion-badge>
          </div>
        </ion-item>
      </ion-list>
      <p v-else-if="loaded" class="muted">No payouts yet.</p>
    </template>

    <template v-else-if="detail">
      <div class="head">
        <div>
          <h2>{{ payoutPeriod(detail.periodStart, detail.periodEnd) }}</h2>
          <ion-badge :color="PAYOUT_STATUS_COLORS[detail.status]">{{
            MKT_PAYOUT_STATUS_LABELS[detail.status]
          }}</ion-badge>
        </div>
        <ion-button fill="outline" size="small" data-testid="statement-csv" @click="download">
          <ion-icon slot="start" :icon="downloadOutline" />Statement (CSV)
        </ion-button>
      </div>
      <div class="cards">
        <StatCard label="Sales" :value="rupees(detail.grossPaise)" />
        <StatCard label="Commission" :value="signedRupees(-detail.commissionPaise)" />
        <StatCard label="Refunds" :value="signedRupees(-detail.refundsPaise)" />
        <StatCard label="Payout" :value="signedRupees(detail.netPaise)" />
      </div>
      <p v-if="detail.paidAt" data-testid="payout-paid-line">
        Paid on {{ dateLabel(detail.paidAt) }} to {{ detail.paidTo }}. Reference (UTR):
        <strong>{{ detail.reference }}</strong>
      </p>
      <p v-else-if="detail.holdReason" class="muted">On hold: {{ detail.holdReason }}</p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th>Order</th>
              <th>Course</th>
              <th>Paid by learner</th>
              <th>Commission</th>
              <th>Your share</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in detail.lines" :key="l.id" :class="{ refund: l.entryType === 'refund' }">
              <td>{{ dateLabel(l.createdAt) }}</td>
              <td>{{ l.entryType === 'refund' ? 'Refund' : 'Sale' }}</td>
              <td>{{ l.orderNumber }}</td>
              <td class="title">{{ l.courseTitle }}</td>
              <td>{{ signedRupees(l.grossPaise) }}</td>
              <td>{{ signedRupees(l.commissionPaise) }} ({{ l.commissionPercent }}%)</td>
              <td>{{ signedRupees(l.netPaise) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { IonBadge, IonButton, IonIcon, IonItem, IonLabel, IonList } from '@ionic/vue';
import { downloadOutline } from 'ionicons/icons';
import { MKT_PAYOUT_STATUS_LABELS, type MktPayoutDetailDto, type MktPayoutDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import StatCard from '@/components/StatCard.vue';
import { toastError } from '@/core/toast';
import { rupees, type StudioScope } from '../api';
import { PAYOUT_STATUS_COLORS, dateLabel, payoutPeriod, payoutStudioApi, signedRupees } from '../payouts-api';

const route = useRoute();
const scope = route.params.scope as StudioScope;
const api = payoutStudioApi(scope);
const id = computed(() => (route.params.id ? Number(route.params.id) : null));
const payouts = ref<MktPayoutDto[]>([]);
const detail = ref<MktPayoutDetailDto | null>(null);
const loaded = ref(false);

async function load() {
  try {
    if (id.value) detail.value = await api.payout(id.value);
    else payouts.value = await api.payouts();
  } catch (e) {
    void toastError(e);
  } finally {
    loaded.value = true;
  }
}

async function download() {
  try {
    if (id.value) await api.statement(id.value);
  } catch (e) {
    void toastError(e);
  }
}

watch(id, load, { immediate: true });
</script>

<style scoped>
.head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.head h2 {
  margin: 0 0 4px;
}
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  margin: 12px 0;
}
.end {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
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
  min-width: 160px;
}
tr.refund td {
  color: var(--ion-color-danger);
}
.muted {
  color: var(--ion-color-medium);
}
</style>
