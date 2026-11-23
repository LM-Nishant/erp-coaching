<template>
  <AppPage
    :title="platform ? 'Marketplace sales' : 'Sales'"
    :back-href="platform ? undefined : `/market/studio/${scope}`"
    :on-refresh="() => load(1)"
  >
    <div v-if="data" class="totals">
      <StatCard label="Gross sales" :value="rupees(data.totals.grossPaise)" />
      <StatCard label="Platform commission" :value="rupees(data.totals.commissionPaise)" />
      <StatCard
        :label="platform ? 'Owed to sellers' : 'Your earnings'"
        :value="rupees(data.totals.netPaise)"
      />
    </div>
    <p class="muted">
      Every sale records what the learner paid, the platform commission and the seller's share. Payouts are
      made monthly.
    </p>
    <div class="table-wrap">
      <table v-if="data?.items.length">
        <thead>
          <tr>
            <th>Date</th>
            <th>Order</th>
            <th>Course</th>
            <th v-if="platform">Seller</th>
            <th>Paid</th>
            <th>Commission</th>
            <th>Net</th>
            <th v-if="platform" />
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in data.items" :key="e.id" :class="{ refund: e.entryType === 'refund' }">
            <td>{{ new Date(e.createdAt).toLocaleDateString() }}</td>
            <td>{{ e.orderNumber }}<template v-if="e.entryType === 'refund'"> · refund</template></td>
            <td>{{ e.courseTitle }}</td>
            <td v-if="platform">{{ e.seller.displayName }}</td>
            <td>{{ signed(e, e.grossPaise) }}</td>
            <td>{{ signed(e, e.commissionPaise) }} ({{ e.commissionPercent }}%)</td>
            <td>{{ signed(e, e.netPaise) }}</td>
            <td v-if="platform">
              <ion-button
                v-if="e.entryType !== 'refund'"
                fill="clear"
                size="small"
                color="danger"
                :data-testid="`refund-sale-${e.id}`"
                @click="refund(e)"
                >Refund</ion-button
              >
            </td>
          </tr>
        </tbody>
      </table>
      <p v-else-if="data" class="muted">No sales yet.</p>
    </div>
    <div v-if="data && data.total > data.pageSize" class="pager">
      <ion-button fill="clear" :disabled="data.page <= 1" @click="load(data.page - 1)">Previous</ion-button>
      <span>Page {{ data.page }} of {{ Math.ceil(data.total / data.pageSize) }}</span>
      <ion-button
        fill="clear"
        :disabled="data.page * data.pageSize >= data.total"
        @click="load(data.page + 1)"
        >Next</ion-button
      >
    </div>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { IonButton } from '@ionic/vue';
import AppPage from '@/components/AppPage.vue';
import StatCard from '@/components/StatCard.vue';
import type { MktLedgerEntryDto } from '@erp/shared';
import { toast, toastError } from '@/core/toast';
import { adminMarketApi, rupees, studioApi, type LedgerPage, type StudioScope } from '../api';
import { payoutAdminApi, refundOutcome, signedRupees } from '../payouts-api';
import { promptText } from '../admin/prompt';

const route = useRoute();
const platform = !!route.meta.superAdmin;
const scope = route.params.scope as StudioScope;
const data = ref<LedgerPage | null>(null);

async function load(page = 1) {
  try {
    data.value = platform ? await adminMarketApi.ledger({ page }) : await studioApi(scope).sales(page);
  } catch (e) {
    void toastError(e);
  }
}
/** Refund rows reverse a sale: shown as negative amounts. */
const signed = (e: MktLedgerEntryDto, paise: number) =>
  signedRupees(e.entryType === 'refund' ? -paise : paise);

async function refund(e: MktLedgerEntryDto) {
  const reason = await promptText(`Refund ${rupees(e.grossPaise)} for ${e.courseTitle}`, {
    message: `Order ${e.orderNumber}. The learner is refunded, loses access to the course and the seller's share is reversed.`,
    placeholder: 'Reason',
    confirm: 'Refund',
  });
  if (!reason) return;
  try {
    const outcome = refundOutcome(
      await payoutAdminApi.refundOrder(e.orderId, { courseId: e.courseId, reason }),
    );
    await toast(outcome.message, outcome.color);
    await load(data.value?.page ?? 1);
  } catch (err) {
    void toastError(err);
  }
}

onMounted(() => load(1));
</script>

<style scoped>
.totals {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
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
.muted {
  color: var(--ion-color-medium);
}
.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}
tr.refund td {
  color: var(--ion-color-danger);
}
</style>
