<template>
  <AppPage
    :title="run ? `Payout run #${run.id}` : 'Payout run'"
    back-href="/admin/marketplace/payouts"
    :on-refresh="load"
  >
    <template v-if="run">
      <div class="head">
        <div>
          <h2>{{ payoutPeriod(run.periodStart, run.periodEnd) }}</h2>
          <p class="muted">
            {{ run.status }} · {{ run.paid }} of {{ run.payouts }} paid · {{ rupees(run.paidNetPaise) }} of
            {{ rupees(run.totalNetPaise) }}
          </p>
        </div>
        <div class="actions">
          <ion-button fill="outline" size="small" data-testid="run-export" @click="exportCsv">
            <ion-icon slot="start" :icon="downloadOutline" />Bank file (CSV)
          </ion-button>
          <template v-if="run.status === 'draft'">
            <ion-button
              size="small"
              fill="outline"
              :disabled="busy"
              data-testid="run-finalize"
              @click="finalize"
              >Finalize</ion-button
            >
            <ion-button size="small" fill="outline" color="danger" :disabled="busy" @click="cancelRun"
              >Cancel run</ion-button
            >
          </template>
        </div>
      </div>

      <ion-card v-for="p in run.items" :key="p.id" :data-testid="`payout-${p.id}`">
        <ion-card-content>
          <div class="row">
            <div>
              <h3>
                {{ p.seller.displayName }} <span class="muted">({{ p.seller.type }})</span>
              </h3>
              <p>
                {{ p.entries }} entries · sales {{ rupees(p.grossPaise) }} · commission
                {{ signedRupees(-p.commissionPaise) }} · refunds {{ signedRupees(-p.refundsPaise) }}
              </p>
            </div>
            <div class="amount">
              <strong>{{ signedRupees(p.netPaise) }}</strong>
              <ion-badge :color="PAYOUT_STATUS_COLORS[p.status]">{{
                MKT_PAYOUT_STATUS_LABELS[p.status]
              }}</ion-badge>
            </div>
          </div>
          <p v-if="p.account">
            To {{ p.account.holderName }} ·
            {{
              p.account.method === 'bank'
                ? `${p.account.bankName ?? 'Bank'} ${revealed[p.id] ?? p.account.maskedAccount} · IFSC ${p.account.ifsc}`
                : `UPI ${revealed[p.id] ?? p.account.maskedAccount}`
            }}
            <ion-button
              v-if="!revealed[p.id] && p.status !== 'paid' && p.status !== 'cancelled'"
              fill="clear"
              size="small"
              @click="reveal(p)"
              >Show full</ion-button
            >
          </p>
          <p v-else class="error">No payout details yet.</p>
          <p v-if="p.paidAt">
            Paid {{ dateLabel(p.paidAt) }} · ref <strong>{{ p.reference }}</strong>
          </p>
          <p v-else-if="p.holdReason" class="muted">On hold: {{ p.holdReason }}</p>
          <div v-if="p.status === 'pending' || p.status === 'held'" class="actions">
            <ion-button
              v-if="p.status === 'pending'"
              size="small"
              :disabled="busy"
              :data-testid="`mark-paid-${p.id}`"
              @click="markPaid(p)"
              >Mark paid</ion-button
            >
            <ion-button
              v-if="p.status === 'pending'"
              size="small"
              fill="outline"
              :disabled="busy"
              @click="hold(p)"
              >Hold</ion-button
            >
            <ion-button
              v-else
              size="small"
              fill="outline"
              :disabled="busy || !p.account"
              :data-testid="`release-${p.id}`"
              @click="act(() => payoutAdminApi.release(p.id), 'Released')"
              >Release</ion-button
            >
            <ion-button size="small" fill="clear" color="danger" :disabled="busy" @click="cancel(p)"
              >Remove from run</ion-button
            >
          </div>
        </ion-card-content>
      </ion-card>
      <p v-if="!run.items.length" class="muted">No payouts in this run.</p>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { IonBadge, IonButton, IonCard, IonCardContent, IonIcon } from '@ionic/vue';
import { downloadOutline } from 'ionicons/icons';
import { MKT_PAYOUT_STATUS_LABELS, type MktPayoutAdminDto, type MktPayoutRunDetailDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { rupees } from '../api';
import { PAYOUT_STATUS_COLORS, dateLabel, payoutAdminApi, payoutPeriod, signedRupees } from '../payouts-api';
import { confirmAction, promptText } from './prompt';

const route = useRoute();
const id = Number(route.params.id);
const run = ref<MktPayoutRunDetailDto | null>(null);
const revealed = reactive<Record<number, string>>({});
const busy = ref(false);

async function load() {
  try {
    run.value = await payoutAdminApi.run(id);
  } catch (e) {
    void toastError(e);
  }
}

async function act(fn: () => Promise<unknown>, done: string) {
  busy.value = true;
  try {
    await fn();
    await toast(done);
    await load();
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

async function reveal(p: MktPayoutAdminDto) {
  try {
    const a = await payoutAdminApi.reveal(p.id);
    revealed[p.id] = a.accountNumber ?? a.upiId ?? a.maskedAccount;
  } catch (e) {
    void toastError(e);
  }
}

async function markPaid(p: MktPayoutAdminDto) {
  const reference = await promptText(`Mark ${signedRupees(p.netPaise)} paid to ${p.seller.displayName}`, {
    message: 'Enter the bank UTR or UPI reference of the transfer. The seller is notified.',
    placeholder: 'UTR / reference',
    confirm: 'Mark paid',
  });
  if (!reference) return;
  await act(() => payoutAdminApi.markPaid(p.id, { reference }), 'Marked paid');
}

async function hold(p: MktPayoutAdminDto) {
  const reason = await promptText(`Hold payout to ${p.seller.displayName}`, {
    placeholder: 'Reason',
    confirm: 'Hold',
  });
  if (!reason) return;
  await act(() => payoutAdminApi.hold(p.id, reason), 'Payout on hold');
}

async function cancel(p: MktPayoutAdminDto) {
  const reason = await promptText(`Remove ${p.seller.displayName} from this run`, {
    message: 'Their entries return to the pending balance for the next run.',
    placeholder: 'Reason (optional)',
    confirm: 'Remove',
  });
  if (reason === null) return;
  await act(() => payoutAdminApi.cancel(p.id, reason), 'Removed from run');
}

async function finalize() {
  if (!run.value) return;
  const ok = await confirmAction(
    'Finalize payout run',
    'Close this run. Payouts still to pay or on hold are removed, and their entries go to the next run.',
    'Finalize',
  );
  if (ok) await act(() => payoutAdminApi.finalizeRun(id), 'Run finalized');
}

async function cancelRun() {
  const ok = await confirmAction(
    'Cancel payout run',
    'Unpaid payouts are cancelled and entries released.',
    'Cancel run',
  );
  if (ok && run.value) await act(() => payoutAdminApi.cancelRun(id), 'Run cancelled');
}

async function exportCsv() {
  try {
    await payoutAdminApi.exportRun(id);
  } catch (e) {
    void toastError(e);
  }
}

onMounted(load);
</script>

<style scoped>
.head,
.row {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
}
.head h2,
.row h3 {
  margin: 0 0 4px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}
.amount {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  font-size: 18px;
}
ion-card {
  margin: 12px 0;
}
.muted {
  color: var(--ion-color-medium);
}
.error {
  color: var(--ion-color-danger);
}
</style>
