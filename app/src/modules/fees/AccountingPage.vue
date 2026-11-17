<template>
  <AppPage title="Accounting" :on-refresh="load">
    <template #actions>
      <ion-button v-can="'accounting.create'" @click="openEntry('expense')">+ Expense</ion-button>
      <ion-button v-can="'accounting.create'" @click="openEntry('income')">+ Income</ion-button>
    </template>
    <ion-item>
      <ion-input v-model="from" type="date" label="From" label-placement="stacked" @ion-change="load" />
      <ion-input v-model="to" type="date" label="To" label-placement="stacked" @ion-change="load" />
      <ion-buttons slot="end" v-can="'accounting.export'">
        <ion-button @click="exportEntries('csv')">CSV</ion-button>
        <ion-button @click="exportEntries('xls')">Excel</ion-button>
      </ion-buttons>
    </ion-item>

    <template v-if="pnl">
      <div class="stats">
        <StatCard label="Income" :value="rupees(pnl.totalIncome)" />
        <StatCard label="Expenditure" :value="rupees(pnl.totalExpenditure)" />
        <StatCard :label="pnl.net >= 0 ? 'Surplus' : 'Deficit'" :value="rupees(Math.abs(pnl.net))" />
        <StatCard
          label="Ledger"
          :value="balanced === null ? '…' : balanced ? 'Balanced' : 'Out of balance'"
          hint="Trial balance"
        />
      </div>
      <div class="pnl">
        <ion-list>
          <ion-list-header>Income</ion-list-header>
          <ion-item v-for="r in pnl.income" :key="r.label"
            ><ion-label>{{ r.label }}</ion-label
            ><ion-note slot="end">{{ rupees(r.amount) }}</ion-note></ion-item
          >
        </ion-list>
        <ion-list>
          <ion-list-header>Expenditure</ion-list-header>
          <ion-item v-for="r in pnl.expenditure" :key="r.label"
            ><ion-label>{{ r.label }}</ion-label
            ><ion-note slot="end">{{ rupees(r.amount) }}</ion-note></ion-item
          >
        </ion-list>
      </div>
    </template>

    <ion-list>
      <ion-list-header>
        <ion-label>Expense & income entries</ion-label>
        <ion-button router-link="/accounting/banks">Bank accounts</ion-button>
      </ion-list-header>
      <ion-item v-for="e in entries" :key="e.id">
        <ion-label :class="{ muted: e.status === 'cancelled' }">
          <h3>
            {{ categoryName(e.categoryId) }} <small v-if="e.party">· {{ e.party }}</small>
          </h3>
          <p>
            {{ e.date }} · {{ MODE_LABELS[e.mode] }}<span v-if="e.reference"> · {{ e.reference }}</span>
          </p>
        </ion-label>
        <ion-note slot="end" :color="e.kind === 'expense' ? 'danger' : 'success'"
          >{{ e.kind === 'expense' ? '−' : '+' }}{{ rupees(e.amount) }}</ion-note
        >
        <ion-button
          v-if="e.status === 'recorded'"
          slot="end"
          v-can="'accounting.delete'"
          fill="clear"
          color="medium"
          @click="cancelEntry(e.id)"
          >Cancel</ion-button
        >
      </ion-item>
      <ion-item v-if="!entries.length"
        ><ion-label class="muted">No entries in this period.</ion-label></ion-item
      >
    </ion-list>

    <ion-modal :is-open="!!form" @did-dismiss="form = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>{{ form?.kind === 'income' ? 'Record income' : 'Record expense' }}</ion-title>
          <ion-buttons slot="end"><ion-button @click="form = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content v-if="form" class="ion-padding">
        <ion-list>
          <ion-item>
            <ion-select v-model="form.categoryId" label="Category" label-placement="stacked">
              <ion-select-option
                v-for="c in categories.filter((x) => x.kind === form?.kind && x.active)"
                :key="c.id"
                :value="c.id"
                >{{ c.name }}</ion-select-option
              >
            </ion-select>
          </ion-item>
          <ion-item>
            <ion-input v-model="form.newCategory" label="…or new category" label-placement="stacked" />
          </ion-item>
          <ion-item
            ><ion-input v-model="form.date" type="date" label="Date" label-placement="stacked"
          /></ion-item>
          <ion-item
            ><ion-input v-model="form.amount" type="number" label="Amount (₹)" label-placement="stacked"
          /></ion-item>
          <ion-item
            ><ion-input v-model="form.tax" type="number" label="GST included (₹)" label-placement="stacked"
          /></ion-item>
          <ion-item>
            <ion-select v-model="form.mode" label="Mode" label-placement="stacked">
              <ion-select-option v-for="m in OFFLINE_PAYMENT_MODES" :key="m" :value="m">{{
                MODE_LABELS[m]
              }}</ion-select-option>
            </ion-select>
          </ion-item>
          <ion-item v-if="form.mode !== 'cash'">
            <ion-select v-model="form.bankAccountId" label="Bank account" label-placement="stacked">
              <ion-select-option :value="null">Default</ion-select-option>
              <ion-select-option v-for="b in banks" :key="b.id" :value="b.id">{{ b.name }}</ion-select-option>
            </ion-select>
          </ion-item>
          <ion-item
            ><ion-input v-model="form.party" label="Paid to / received from" label-placement="stacked"
          /></ion-item>
          <ion-item
            ><ion-input v-model="form.reference" label="Bill / reference no." label-placement="stacked"
          /></ion-item>
          <ion-item><ion-textarea v-model="form.notes" label="Notes" label-placement="stacked" /></ion-item>
        </ion-list>
        <ion-button expand="block" :disabled="saving" @click="saveEntry">Save</ion-button>
      </ion-content>
    </ion-modal>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonModal,
  IonNote,
  IonSelect,
  IonSelectOption,
  IonTextarea,
  IonTitle,
  IonToolbar,
} from '@ionic/vue';
import {
  OFFLINE_PAYMENT_MODES,
  type BankAccountDto,
  type FinanceCategoryDto,
  type FinanceEntryDto,
  type FinanceEntryKind,
  type OfflinePaymentMode,
  type ProfitLossDto,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import StatCard from '@/components/StatCard.vue';
import { toast, toastError } from '@/core/toast';
import { rupees, todayIso } from '../hr/api';
import { MODE_LABELS, downloadFeesReport, feesApi, toPaise } from './api';

const from = ref(`${todayIso().slice(0, 8)}01`);
const to = ref(todayIso());
const pnl = ref<ProfitLossDto | null>(null);
const balanced = ref<boolean | null>(null);
const entries = ref<FinanceEntryDto[]>([]);
const categories = ref<FinanceCategoryDto[]>([]);
const banks = ref<BankAccountDto[]>([]);
const saving = ref(false);
const form = ref<{
  kind: FinanceEntryKind;
  categoryId: number | null;
  newCategory: string;
  date: string;
  amount: string;
  tax: string;
  mode: OfflinePaymentMode;
  bankAccountId: number | null;
  party: string;
  reference: string;
  notes: string;
} | null>(null);

const categoryName = (id: number) => categories.value.find((c) => c.id === id)?.name ?? 'Uncategorised';

async function load() {
  try {
    const [p, e, c, tb] = await Promise.all([
      feesApi.pnl(from.value, to.value),
      feesApi.entries({ from: from.value, to: to.value }),
      feesApi.categories(),
      feesApi.trialBalance().catch(() => null),
    ]);
    pnl.value = p;
    entries.value = e.items;
    categories.value = c;
    balanced.value = tb ? tb.balanced : null;
  } catch (e) {
    void toastError(e);
  }
}

async function openEntry(kind: FinanceEntryKind) {
  form.value = {
    kind,
    categoryId: null,
    newCategory: '',
    date: todayIso(),
    amount: '',
    tax: '',
    mode: 'cash',
    bankAccountId: null,
    party: '',
    reference: '',
    notes: '',
  };
  banks.value = await feesApi.bankAccounts().catch(() => []);
}

async function saveEntry() {
  const f = form.value;
  if (!f) return;
  saving.value = true;
  try {
    let categoryId = f.categoryId;
    if (f.newCategory) categoryId = (await feesApi.createCategory({ kind: f.kind, name: f.newCategory })).id;
    if (!categoryId) throw new Error('Pick a category');
    await feesApi.createEntry({
      kind: f.kind,
      categoryId,
      date: f.date,
      amount: toPaise(f.amount),
      tax: f.tax ? toPaise(f.tax) : undefined,
      mode: f.mode,
      bankAccountId: f.mode === 'cash' ? null : f.bankAccountId,
      party: f.party || null,
      reference: f.reference || null,
      notes: f.notes || null,
    });
    await toast('Saved');
    form.value = null;
    await load();
  } catch (e) {
    void toastError(e);
  } finally {
    saving.value = false;
  }
}

async function cancelEntry(id: number) {
  try {
    await feesApi.cancelEntry(id);
    await load();
  } catch (e) {
    void toastError(e);
  }
}

async function exportEntries(format: 'csv' | 'xls') {
  try {
    await downloadFeesReport('finance/entries', { from: from.value, to: to.value }, format);
  } catch (e) {
    void toastError(e);
  }
}

onMounted(load);
</script>

<style scoped>
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 12px;
  margin: 12px 0;
}
.pnl {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 12px;
}
</style>
