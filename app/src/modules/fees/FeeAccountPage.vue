<template>
  <AppPage :title="a ? `${a.studentName ?? 'Student'} · fees` : 'Fee account'" :on-refresh="load">
    <template v-if="a">
      <ion-card>
        <ion-card-header>
          <ion-card-subtitle>{{ a.admissionNumber }} · {{ a.title }}</ion-card-subtitle>
          <ion-card-title>{{ rupees(a.balance) }} due</ion-card-title>
        </ion-card-header>
        <ion-card-content>
          Gross {{ rupees(a.gross) }} − discounts {{ rupees(a.discount) }} + charges {{ rupees(a.charges) }} +
          late fee {{ rupees(a.lateFee) }} = <strong>{{ rupees(a.net) }}</strong> · paid {{ rupees(a.paid) }}
          <span v-if="a.advance"> · advance {{ rupees(a.advance) }}</span>
          <ion-badge :color="STATUS_COLORS[a.status]" class="ml">{{ a.status }}</ion-badge>
          <div v-if="a.status === 'active'" class="actions">
            <ion-button v-can="'fees.create'" size="small" @click="openPay">Collect payment</ion-button>
            <ion-button v-can="'fees.create'" size="small" fill="outline" @click="openAdjust"
              >Discount / concession</ion-button
            >
            <ion-button size="small" fill="outline" @click="showLedger">Ledger</ion-button>
            <ion-button v-can="'fees.delete'" size="small" fill="clear" color="danger" @click="cancelAccount"
              >Cancel account</ion-button
            >
          </div>
        </ion-card-content>
      </ion-card>

      <ion-list>
        <ion-list-header>Instalments</ion-list-header>
        <ion-item v-for="i in a.instalments ?? []" :key="i.id">
          <ion-label>
            <h3>{{ i.label }}</h3>
            <p>
              Due {{ i.dueDate }} · {{ rupees(i.amount)
              }}<span v-if="i.lateFee"> + late {{ rupees(i.lateFee) }}</span> · paid {{ rupees(i.paid) }}
            </p>
          </ion-label>
          <ion-badge slot="end" :color="i.overdue ? 'danger' : STATUS_COLORS[i.status]">{{
            i.overdue ? 'overdue' : i.status
          }}</ion-badge>
        </ion-item>

        <ion-list-header>Payments</ion-list-header>
        <ion-item v-for="p in a.payments" :key="p.id">
          <ion-label>
            <h3>
              {{ rupees(p.amount) }} · {{ MODE_LABELS[p.mode]
              }}<span v-if="p.gateway"> ({{ p.gateway }})</span>
            </h3>
            <p>
              {{ p.paidOn ?? p.createdAt.slice(0, 10) }}
              <span v-if="p.receiptNumber"> · receipt {{ p.receiptNumber }}</span>
              <span v-if="p.referenceNo || p.chequeNumber"> · ref {{ p.referenceNo ?? p.chequeNumber }}</span>
              <span v-if="p.refunded"> · refunded {{ rupees(p.refunded) }}</span>
            </p>
            <p v-if="p.approvalStatus === 'pending'" class="muted">Awaiting approval</p>
          </ion-label>
          <ion-badge slot="end" :color="STATUS_COLORS[p.status]">{{ p.status.replace('_', ' ') }}</ion-badge>
          <ion-buttons slot="end">
            <template v-if="p.receiptId">
              <ion-button title="Receipt PDF" aria-label="Receipt PDF" @click="pdf(p.receiptId)"
                ><ion-icon slot="icon-only" :icon="documentOutline"
              /></ion-button>
              <ion-button title="Share on WhatsApp" aria-label="Share on WhatsApp" @click="share(p.receiptId)"
                ><ion-icon slot="icon-only" :icon="logoWhatsapp"
              /></ion-button>
            </template>
            <ion-button
              v-if="p.status === 'successful' || p.status === 'partially_refunded'"
              v-can="'fees.approve'"
              title="Refund / cancel"
              color="danger"
              aria-label="Refund / cancel"
              @click="openRefund(p)"
              ><ion-icon slot="icon-only" :icon="returnDownBackOutline"
            /></ion-button>
          </ion-buttons>
        </ion-item>
        <ion-item v-if="!a.payments.length"><ion-label class="muted">No payments yet.</ion-label></ion-item>

        <ion-list-header>Discounts, concessions & charges</ion-list-header>
        <ion-item v-for="d in a.adjustments ?? []" :key="d.id">
          <ion-label>
            <h3>
              {{ d.type }} · {{ d.mode === 'percent' ? `${d.value}%` : rupees(d.value) }} =
              {{ rupees(d.amount) }}
            </h3>
            <p class="muted">{{ d.reason }}</p>
          </ion-label>
          <ion-badge slot="end" :color="STATUS_COLORS[d.status]">{{ d.status }}</ion-badge>
          <ion-buttons v-if="d.status === 'pending'" slot="end" v-can="'fees.approve'">
            <ion-button color="success" @click="decide(d.id, true)">Approve</ion-button>
            <ion-button color="danger" @click="decide(d.id, false)">Reject</ion-button>
          </ion-buttons>
        </ion-item>
      </ion-list>
    </template>

    <ion-modal :is-open="!!pay" @did-dismiss="pay = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>Collect payment</ion-title>
          <ion-buttons slot="end"><ion-button @click="pay = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content v-if="pay" class="ion-padding">
        <ion-list>
          <ion-item>
            <ion-input v-model="pay.amount" type="number" label="Amount (₹)" label-placement="stacked" />
          </ion-item>
          <ion-item>
            <ion-select v-model="pay.mode" label="Mode" label-placement="stacked">
              <ion-select-option v-for="m in OFFLINE_PAYMENT_MODES" :key="m" :value="m">{{
                MODE_LABELS[m]
              }}</ion-select-option>
            </ion-select>
          </ion-item>
          <ion-item
            ><ion-input v-model="pay.paidOn" type="date" label="Paid on" label-placement="stacked"
          /></ion-item>
          <ion-item v-if="pay.mode !== 'cash' && pay.mode !== 'cheque'">
            <ion-input v-model="pay.referenceNo" label="UTR / reference" label-placement="stacked" />
          </ion-item>
          <template v-if="pay.mode === 'cheque'">
            <ion-item
              ><ion-input v-model="pay.chequeNumber" label="Cheque no." label-placement="stacked"
            /></ion-item>
            <ion-item
              ><ion-input v-model="pay.chequeDate" type="date" label="Cheque date" label-placement="stacked"
            /></ion-item>
            <ion-item><ion-input v-model="pay.bankName" label="Bank" label-placement="stacked" /></ion-item>
          </template>
          <ion-item v-if="pay.mode !== 'cash' && banks.length">
            <ion-select v-model="pay.bankAccountId" label="Deposited to" label-placement="stacked">
              <ion-select-option :value="null">Default bank</ion-select-option>
              <ion-select-option v-for="b in banks" :key="b.id" :value="b.id">{{ b.name }}</ion-select-option>
            </ion-select>
          </ion-item>
          <ion-item><ion-textarea v-model="pay.notes" label="Notes" label-placement="stacked" /></ion-item>
        </ion-list>
        <p class="muted">
          Amounts above the balance are kept as advance. Instalments are settled oldest first.
        </p>
        <ion-button expand="block" :disabled="saving" @click="savePay">Record payment</ion-button>
      </ion-content>
    </ion-modal>

    <ion-modal :is-open="!!adjust" @did-dismiss="adjust = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>Discount / concession</ion-title>
          <ion-buttons slot="end"><ion-button @click="adjust = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content v-if="adjust" class="ion-padding">
        <ion-list>
          <ion-item>
            <ion-select v-model="adjust.ruleId" label="Concession rule" label-placement="stacked">
              <ion-select-option :value="null">Manual</ion-select-option>
              <ion-select-option v-for="r in rules" :key="r.id" :value="r.id"
                >{{ r.name }} ({{
                  r.mode === 'percent' ? `${r.value}%` : rupees(r.value)
                }})</ion-select-option
              >
            </ion-select>
          </ion-item>
          <template v-if="!adjust.ruleId">
            <ion-item>
              <ion-select v-model="adjust.type" label="Type" label-placement="stacked">
                <ion-select-option v-for="t in FEE_ADJUSTMENT_TYPES" :key="t" :value="t">{{
                  t
                }}</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-select v-model="adjust.mode" label="Amount type" label-placement="stacked">
                <ion-select-option value="fixed">Fixed ₹</ion-select-option>
                <ion-select-option value="percent">Percent of gross</ion-select-option>
              </ion-select>
            </ion-item>
            <ion-item>
              <ion-input
                v-model="adjust.value"
                type="number"
                :label="adjust.mode === 'percent' ? 'Percent' : 'Amount (₹)'"
                label-placement="stacked"
              />
            </ion-item>
          </template>
          <ion-item><ion-input v-model="adjust.reason" label="Reason" label-placement="stacked" /></ion-item>
        </ion-list>
        <p class="muted">Large concessions may need approval by an admin before they apply.</p>
        <ion-button expand="block" :disabled="saving" @click="saveAdjust">Submit</ion-button>
      </ion-content>
    </ion-modal>

    <ion-modal :is-open="!!refund" @did-dismiss="refund = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>Refund / cancel payment</ion-title>
          <ion-buttons slot="end"><ion-button @click="refund = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content v-if="refund" class="ion-padding">
        <p>{{ rupees(refund.payment.amount - refund.payment.refunded) }} refundable.</p>
        <ion-list>
          <ion-item>
            <ion-input
              v-model="refund.amount"
              type="number"
              label="Refund amount (₹, blank = full)"
              label-placement="stacked"
            />
          </ion-item>
          <ion-item><ion-input v-model="refund.reason" label="Reason" label-placement="stacked" /></ion-item>
          <ion-item
            ><ion-checkbox v-model="refund.reduceDues"
              >Also reduce the fee due (fee waived, not re-collected)</ion-checkbox
            ></ion-item
          >
        </ion-list>
        <ion-button expand="block" color="danger" :disabled="saving" @click="saveRefund">Refund</ion-button>
        <ion-button
          v-if="refund.payment.mode !== 'online' && !refund.payment.refunded"
          expand="block"
          fill="outline"
          color="medium"
          :disabled="saving"
          @click="cancelPayment"
          >Cancel payment (entered by mistake)</ion-button
        >
      </ion-content>
    </ion-modal>

    <ion-modal :is-open="!!ledger" @did-dismiss="ledger = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>Ledger</ion-title>
          <ion-buttons slot="end"><ion-button @click="ledger = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content class="ion-padding">
        <table class="ledger">
          <thead>
            <tr>
              <th>Date</th>
              <th>Account</th>
              <th>Narration</th>
              <th>Dr</th>
              <th>Cr</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in ledger ?? []" :key="l.id">
              <td>{{ l.date }}</td>
              <td>{{ l.account }}</td>
              <td>{{ l.narration }}</td>
              <td>{{ l.debit ? rupees(l.debit) : '' }}</td>
              <td>{{ l.credit ? rupees(l.credit) : '' }}</td>
            </tr>
          </tbody>
        </table>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardSubtitle,
  IonCardTitle,
  IonCheckbox,
  IonContent,
  IonHeader,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonModal,
  IonSelect,
  IonSelectOption,
  IonTextarea,
  IonTitle,
  IonToolbar,
} from '@ionic/vue';
import { documentOutline, logoWhatsapp, returnDownBackOutline } from 'ionicons/icons';
import {
  FEE_ADJUSTMENT_TYPES,
  OFFLINE_PAYMENT_MODES,
  type BankAccountDto,
  type FeeAdjustmentType,
  type FeePaymentDto,
  type LedgerEntryDto,
  type OfflinePaymentMode,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { rupees, todayIso } from '../hr/api';
import {
  MODE_LABELS,
  STATUS_COLORS,
  feesApi,
  openSigned,
  toPaise,
  type AccountDetail,
  type ConcessionRule,
} from './api';

const id = Number(useRoute().params.id);
const a = ref<AccountDetail | null>(null);
const banks = ref<BankAccountDto[]>([]);
const rules = ref<ConcessionRule[]>([]);
const ledger = ref<LedgerEntryDto[] | null>(null);
const saving = ref(false);
const pay = ref<{
  amount: string;
  mode: OfflinePaymentMode;
  paidOn: string;
  referenceNo: string;
  chequeNumber: string;
  chequeDate: string;
  bankName: string;
  bankAccountId: number | null;
  notes: string;
} | null>(null);
const adjust = ref<{
  ruleId: number | null;
  type: FeeAdjustmentType;
  mode: 'fixed' | 'percent';
  value: string;
  reason: string;
} | null>(null);
const refund = ref<{ payment: FeePaymentDto; amount: string; reason: string; reduceDues: boolean } | null>(
  null,
);

async function run(fn: () => Promise<unknown>, done?: string) {
  saving.value = true;
  try {
    await fn();
    if (done) await toast(done);
    await load();
    return true;
  } catch (e) {
    void toastError(e);
    return false;
  } finally {
    saving.value = false;
  }
}

async function load() {
  try {
    a.value = await feesApi.account(id);
  } catch (e) {
    void toastError(e);
  }
}

async function openPay() {
  pay.value = {
    amount: String((a.value?.balance ?? 0) / 100),
    mode: 'cash',
    paidOn: todayIso(),
    referenceNo: '',
    chequeNumber: '',
    chequeDate: '',
    bankName: '',
    bankAccountId: null,
    notes: '',
  };
  banks.value = await feesApi.bankAccounts().catch(() => []);
}

async function savePay() {
  const p = pay.value;
  if (!p) return;
  const ok = await run(async () => {
    const r = await feesApi.recordOffline({
      accountId: id,
      amount: toPaise(p.amount),
      mode: p.mode,
      paidOn: p.paidOn,
      referenceNo: p.referenceNo || null,
      chequeNumber: p.chequeNumber || null,
      chequeDate: p.chequeDate || null,
      bankName: p.bankName || null,
      bankAccountId: p.bankAccountId,
      notes: p.notes || null,
    });
    await toast(
      r.status === 'successful' ? `Receipt ${r.receiptNumber} issued` : 'Payment recorded; awaiting approval',
    );
  });
  if (ok) pay.value = null;
}

async function openAdjust() {
  adjust.value = { ruleId: null, type: 'discount', mode: 'fixed', value: '', reason: '' };
  rules.value = (await feesApi.rules().catch(() => [])).filter((r) => r.active);
}

async function saveAdjust() {
  const d = adjust.value;
  if (!d) return;
  const body = d.ruleId
    ? { ruleId: d.ruleId, reason: d.reason || null }
    : {
        type: d.type,
        mode: d.mode,
        value: d.mode === 'percent' ? Number(d.value) : toPaise(d.value),
        reason: d.reason || null,
      };
  const ok = await run(async () => {
    const r = await feesApi.requestAdjustment(id, body);
    await toast(r.status === 'approved' ? 'Applied' : 'Submitted for approval');
  });
  if (ok) adjust.value = null;
}

const decide = (adjId: number, approve: boolean) =>
  run(() => feesApi.decideAdjustment(adjId, approve), approve ? 'Approved' : 'Rejected');

function openRefund(payment: FeePaymentDto) {
  refund.value = { payment, amount: '', reason: '', reduceDues: false };
}
async function saveRefund() {
  const r = refund.value;
  if (!r) return;
  const ok = await run(
    () =>
      feesApi.refund(r.payment.id, {
        amount: r.amount ? toPaise(r.amount) : undefined,
        reason: r.reason || undefined,
        reduceDues: r.reduceDues,
      }),
    'Refund recorded',
  );
  if (ok) refund.value = null;
}
async function cancelPayment() {
  const r = refund.value;
  if (!r) return;
  if (await run(() => feesApi.cancelPayment(r.payment.id, r.reason || undefined), 'Payment cancelled'))
    refund.value = null;
}

async function cancelAccount() {
  if (!window.confirm('Cancel this fee account? Outstanding dues will be written off.')) return;
  await run(() => feesApi.cancelAccount(id), 'Account cancelled');
}

async function showLedger() {
  try {
    ledger.value = await feesApi.ledger(id);
  } catch (e) {
    void toastError(e);
  }
}

const pdf = async (receiptId: number) => {
  try {
    openSigned(await feesApi.receiptPdf(receiptId));
  } catch (e) {
    void toastError(e);
  }
};
const share = (receiptId: number) => run(() => feesApi.shareReceipt(receiptId), 'Receipt sent on WhatsApp');

onMounted(load);
</script>

<style scoped>
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 8px;
}
.ml {
  margin-left: 8px;
}
.ledger {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}
.ledger th,
.ledger td {
  border-bottom: 1px solid var(--ion-color-light-shade);
  padding: 4px;
  text-align: left;
}
</style>
