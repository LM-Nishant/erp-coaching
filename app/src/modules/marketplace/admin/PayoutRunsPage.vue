<template>
  <AppPage title="Marketplace payouts" :on-refresh="load">
    <template #actions>
      <ion-button router-link="/admin/marketplace/refunds" data-testid="open-refunds">Refunds</ion-button>
    </template>

    <section v-if="settings" class="settings" aria-label="Payout settings">
      <h3>Payout settings</h3>
      <div class="fields">
        <ion-input
          v-model.number="minRupees"
          type="number"
          label="Minimum payout (₹)"
          label-placement="stacked"
          fill="outline"
          :min="0"
          data-testid="setting-min"
        />
        <ion-input
          v-model.number="settings.holdDays"
          type="number"
          label="Hold sales for (days)"
          label-placement="stacked"
          fill="outline"
          :min="0"
          helper-text="Sales are paid only after this many days"
          data-testid="setting-hold"
        />
        <ion-input
          v-model.number="settings.refundWindowDays"
          type="number"
          label="Refund window (days)"
          label-placement="stacked"
          fill="outline"
          :min="0"
          helper-text="Learners can ask for a refund within this time"
        />
      </div>
      <p v-if="settings.holdDays < settings.refundWindowDays" class="warn">
        Sales can be refunded after they are paid out; refunds are then deducted from the seller's next
        payout.
      </p>
      <ion-button size="small" :disabled="busy" data-testid="setting-save" @click="saveSettings"
        >Save settings</ion-button
      >
    </section>

    <section aria-label="Next payout run">
      <h3>Next payout run</h3>
      <div class="period">
        <ion-input
          v-model="periodEnd"
          type="date"
          label="Pay sales up to"
          label-placement="stacked"
          fill="outline"
          data-testid="period-end"
          @ion-change="loadPreview"
        />
        <ion-button :disabled="busy || !due.length || !!openRun" data-testid="create-run" @click="createRun">
          Create payout run
        </ion-button>
      </div>
      <p v-if="openRun" class="warn">
        Payout run #{{ openRun.id }} is still open.
        <router-link :to="`/admin/marketplace/payouts/${openRun.id}`">Finish or cancel it</router-link> before
        creating another.
      </p>
      <template v-if="preview">
        <p class="muted">
          Sales before {{ dateLabel(preview.eligibleBefore) }} (past the {{ preview.settings.holdDays }}-day
          hold) and all refunds. Sellers below {{ rupees(preview.settings.minPayoutPaise) }} are carried
          forward.
        </p>
        <div class="table-wrap">
          <table v-if="preview.rows.length" data-testid="payout-preview">
            <thead>
              <tr>
                <th>Seller</th>
                <th>Entries</th>
                <th>Sales</th>
                <th>Commission</th>
                <th>Refunds</th>
                <th>Payout</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in preview.rows" :key="r.seller.id" :class="{ carried: r.carriedForward }">
                <td>
                  {{ r.seller.displayName }} <span class="muted">({{ r.seller.type }})</span>
                </td>
                <td>{{ r.entries }}</td>
                <td>{{ rupees(r.grossPaise) }}</td>
                <td>{{ signedRupees(-r.commissionPaise) }}</td>
                <td>{{ signedRupees(-r.refundsPaise) }}</td>
                <td>
                  <strong>{{ signedRupees(r.netPaise) }}</strong>
                </td>
                <td>
                  <ion-badge v-if="r.carriedForward" color="medium">Carried forward</ion-badge>
                  <ion-badge v-else-if="!r.hasAccount" color="danger">No payout details</ion-badge>
                </td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td colspan="5">Total to pay</td>
                <td>
                  <strong>{{ rupees(preview.totalNetPaise) }}</strong>
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
          <p v-else class="muted">Nothing is due for this period.</p>
        </div>
      </template>
    </section>

    <section aria-label="Payout runs">
      <h3>Payout runs</h3>
      <ion-list v-if="runs.length">
        <ion-item
          v-for="r in runs"
          :key="r.id"
          :router-link="`/admin/marketplace/payouts/${r.id}`"
          detail
          :data-testid="`run-${r.id}`"
        >
          <ion-label>
            <h3>#{{ r.id }} · {{ payoutPeriod(r.periodStart, r.periodEnd) }}</h3>
            <p>
              {{ r.paid }} of {{ r.payouts }} paid · {{ rupees(r.paidNetPaise) }} of
              {{ rupees(r.totalNetPaise) }}
            </p>
          </ion-label>
          <ion-badge slot="end" :color="RUN_COLORS[r.status]">{{ r.status }}</ion-badge>
        </ion-item>
      </ion-list>
      <p v-else class="muted">No payout runs yet.</p>
    </section>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { IonBadge, IonButton, IonInput, IonItem, IonLabel, IonList } from '@ionic/vue';
import type {
  MktPayoutPreviewDto,
  MktPayoutRunDto,
  MktPayoutRunStatus,
  MktPayoutSettingsDto,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { rupees } from '../api';
import { dateLabel, payoutAdminApi, payoutPeriod, signedRupees } from '../payouts-api';
import { confirmAction } from './prompt';

const RUN_COLORS: Record<MktPayoutRunStatus, string> = {
  draft: 'warning',
  finalized: 'success',
  cancelled: 'medium',
};

const router = useRouter();
const settings = ref<MktPayoutSettingsDto | null>(null);
const minRupees = ref(0);
const preview = ref<MktPayoutPreviewDto | null>(null);
const runs = ref<MktPayoutRunDto[]>([]);
const busy = ref(false);
/** Last day of the previous month (IST): the default run pays everything sold up to the end of last month. */
const periodEnd = ref(lastMonthEnd());

function lastMonthEnd(): string {
  const ist = new Date(Date.now() + 5.5 * 3600_000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), 0)).toISOString().slice(0, 10);
}

const due = computed(() => (preview.value?.rows ?? []).filter((r) => !r.carriedForward));
const openRun = computed(() => runs.value.find((r) => r.status === 'draft'));

async function loadPreview() {
  try {
    preview.value = await payoutAdminApi.preview(periodEnd.value || undefined);
  } catch (e) {
    void toastError(e);
  }
}

async function load() {
  try {
    const [s, r] = await Promise.all([payoutAdminApi.settings(), payoutAdminApi.runs()]);
    settings.value = s;
    minRupees.value = s.minPayoutPaise / 100;
    runs.value = r;
  } catch (e) {
    void toastError(e);
  }
  await loadPreview();
}

async function saveSettings() {
  if (!settings.value) return;
  busy.value = true;
  try {
    settings.value = await payoutAdminApi.saveSettings({
      minPayoutPaise: Math.round(Number(minRupees.value || 0) * 100),
      holdDays: Number(settings.value.holdDays),
      refundWindowDays: Number(settings.value.refundWindowDays),
    });
    await toast('Payout settings saved');
    await loadPreview();
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

async function createRun() {
  if (!preview.value) return;
  const ok = await confirmAction(
    'Create payout run',
    `${due.value.length} seller(s), ${rupees(preview.value.totalNetPaise)} in total. Their ledger entries are reserved for this run.`,
    'Create',
  );
  if (!ok) return;
  busy.value = true;
  try {
    const run = await payoutAdminApi.createRun(periodEnd.value || undefined);
    await toast('Payout run created');
    await router.push(`/admin/marketplace/payouts/${run.id}`);
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
section {
  margin-bottom: 24px;
}
.fields,
.period {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
  max-width: 760px;
  margin-bottom: 8px;
}
.fields {
  align-items: start;
}
.period {
  align-items: center;
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
tr.carried td {
  color: var(--ion-color-medium);
}
.muted {
  color: var(--ion-color-medium);
}
.warn {
  color: var(--ion-color-warning-shade);
}
</style>
