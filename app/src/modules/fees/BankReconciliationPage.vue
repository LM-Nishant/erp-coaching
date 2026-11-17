<template>
  <AppPage title="Bank accounts" :on-refresh="load">
    <template #actions>
      <ion-button v-can="'accounting.create'" @click="openBank()"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>
    <ion-list>
      <ion-item
        v-for="b in banks"
        :key="b.id"
        button
        :color="selected?.id === b.id ? 'light' : undefined"
        @click="select(b)"
      >
        <ion-label>
          <h3>{{ b.name }}</h3>
          <p>
            {{ b.bankName }}<span v-if="b.accountNumberLast4"> ·· {{ b.accountNumberLast4 }}</span>
            {{ b.ifsc }}
          </p>
        </ion-label>
        <ion-note slot="end">{{ rupees(b.balance ?? b.openingBalance) }}</ion-note>
        <ion-button slot="end" v-can="'accounting.edit'" fill="clear" @click.stop="openBank(b)"
          >Edit</ion-button
        >
      </ion-item>
      <ion-item v-if="!banks.length"><ion-label class="muted">No bank accounts yet.</ion-label></ion-item>
    </ion-list>

    <template v-if="selected">
      <ion-segment v-model="lineStatus" @ion-change="loadLines">
        <ion-segment-button value="unmatched">Unmatched</ion-segment-button>
        <ion-segment-button value="matched">Matched</ion-segment-button>
        <ion-segment-button value="ignored">Ignored</ion-segment-button>
      </ion-segment>
      <ion-list>
        <ion-list-header>
          <ion-label>{{ selected.name }} statement</ion-label>
          <ion-button v-can="'accounting.create'" @click="importing = { csv: '' }">Import CSV</ion-button>
        </ion-list-header>
        <template v-for="l in lines" :key="l.id">
          <ion-item button @click="toggle(l)">
            <ion-label>
              <h3>{{ l.description ?? '—' }}</h3>
              <p>
                {{ l.txnDate }}<span v-if="l.reference"> · {{ l.reference }}</span>
              </p>
              <p v-if="l.matchedType" class="muted">
                Matched to {{ l.matchedType.replace('_', ' ') }} #{{ l.matchedId }}
              </p>
            </ion-label>
            <ion-note slot="end" :color="l.amount < 0 ? 'danger' : 'success'">{{
              rupees(l.amount)
            }}</ion-note>
          </ion-item>
          <div v-if="open === l.id" class="suggest">
            <template v-if="l.status === 'unmatched'">
              <p v-if="!suggest.payments.length && !suggest.entries.length" class="muted">
                No candidates (±5 days, same amount).
              </p>
              <ion-item v-for="p in suggest.payments" :key="`p${p.id}`">
                <ion-label>Fee payment · {{ p.student }} · {{ p.date }} {{ p.reference }}</ion-label>
                <ion-button slot="end" @click="reconcile(l, 'match', 'payment', p.id)">Match</ion-button>
              </ion-item>
              <ion-item v-for="e in suggest.entries" :key="`e${e.id}`">
                <ion-label>{{ e.kind }} · {{ e.party }} · {{ e.date }} {{ e.reference }}</ion-label>
                <ion-button slot="end" @click="reconcile(l, 'match', 'finance_entry', e.id)"
                  >Match</ion-button
                >
              </ion-item>
              <ion-button fill="clear" color="medium" @click="reconcile(l, 'ignore')">Ignore line</ion-button>
            </template>
            <ion-button v-else fill="clear" @click="reconcile(l, 'unmatch')">Undo</ion-button>
          </div>
        </template>
        <ion-item v-if="!lines.length"><ion-label class="muted">No lines.</ion-label></ion-item>
      </ion-list>
    </template>

    <ion-modal :is-open="!!bankForm" @did-dismiss="bankForm = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>Bank account</ion-title>
          <ion-buttons slot="end"><ion-button @click="bankForm = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content v-if="bankForm" class="ion-padding">
        <ion-list>
          <ion-item><ion-input v-model="bankForm.name" label="Name" label-placement="stacked" /></ion-item>
          <ion-item
            ><ion-input v-model="bankForm.bankName" label="Bank" label-placement="stacked"
          /></ion-item>
          <ion-item>
            <ion-input
              v-model="bankForm.accountNumberLast4"
              :maxlength="4"
              label="A/c no. last 4"
              label-placement="stacked"
            />
          </ion-item>
          <ion-item><ion-input v-model="bankForm.ifsc" label="IFSC" label-placement="stacked" /></ion-item>
          <ion-item v-if="!bankForm.id">
            <ion-input
              v-model="bankForm.opening"
              type="number"
              label="Opening balance (₹)"
              label-placement="stacked"
            />
          </ion-item>
        </ion-list>
        <ion-button expand="block" @click="saveBank">Save</ion-button>
      </ion-content>
    </ion-modal>

    <ion-modal :is-open="!!importing" @did-dismiss="importing = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>Import statement</ion-title>
          <ion-buttons slot="end"><ion-button @click="importing = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content v-if="importing" class="ion-padding">
        <p class="muted">
          CSV columns: date (YYYY-MM-DD), description, reference, amount in ₹ (negative for debits).
        </p>
        <input type="file" accept=".csv,text/csv" @change="readFile" />
        <ion-textarea v-model="importing.csv" :rows="10" placeholder="date,description,reference,amount" />
        <ion-button expand="block" @click="doImport">Import</ion-button>
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
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonModal,
  IonNote,
  IonSegment,
  IonSegmentButton,
  IonTextarea,
  IonTitle,
  IonToolbar,
} from '@ionic/vue';
import { add } from 'ionicons/icons';
import type { BankAccountDto, BankStatementLineDto, FinanceEntryDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { rupees } from '../hr/api';
import { feesApi, toPaise } from './api';

const banks = ref<BankAccountDto[]>([]);
const selected = ref<BankAccountDto | null>(null);
const lineStatus = ref<'unmatched' | 'matched' | 'ignored'>('unmatched');
const lines = ref<BankStatementLineDto[]>([]);
const open = ref<number | null>(null);
const suggest = ref<{
  payments: { id: number; date: string; amount: number; student?: string; reference: string | null }[];
  entries: FinanceEntryDto[];
}>({ payments: [], entries: [] });
const bankForm = ref<{
  id?: number;
  name: string;
  bankName: string;
  accountNumberLast4: string;
  ifsc: string;
  opening: string;
} | null>(null);
const importing = ref<{ csv: string } | null>(null);

async function load() {
  try {
    banks.value = await feesApi.bankAccounts();
    if (selected.value) await loadLines();
  } catch (e) {
    void toastError(e);
  }
}

async function select(b: BankAccountDto) {
  selected.value = b;
  await loadLines();
}

async function loadLines() {
  if (!selected.value) return;
  open.value = null;
  try {
    lines.value = await feesApi.statement(selected.value.id, lineStatus.value);
  } catch (e) {
    void toastError(e);
  }
}

async function toggle(l: BankStatementLineDto) {
  if (open.value === l.id) {
    open.value = null;
    return;
  }
  open.value = l.id;
  suggest.value = { payments: [], entries: [] };
  if (l.status === 'unmatched')
    try {
      suggest.value = await feesApi.suggestions(l.id);
    } catch (e) {
      void toastError(e);
    }
}

async function reconcile(
  l: BankStatementLineDto,
  action: 'match' | 'ignore' | 'unmatch',
  type?: 'payment' | 'finance_entry',
  id?: number,
) {
  try {
    await feesApi.reconcile(l.id, { action, type, id });
    await toast(action === 'match' ? 'Reconciled' : 'Updated');
    await loadLines();
  } catch (e) {
    void toastError(e);
  }
}

function openBank(b?: BankAccountDto) {
  bankForm.value = {
    id: b?.id,
    name: b?.name ?? '',
    bankName: b?.bankName ?? '',
    accountNumberLast4: b?.accountNumberLast4 ?? '',
    ifsc: b?.ifsc ?? '',
    opening: '',
  };
}

async function saveBank() {
  const f = bankForm.value;
  if (!f) return;
  try {
    await feesApi.saveBankAccount(
      {
        name: f.name,
        bankName: f.bankName || null,
        accountNumberLast4: f.accountNumberLast4 || null,
        ifsc: f.ifsc.trim().toUpperCase() || null,
        ...(f.id ? {} : { openingBalance: toPaise(f.opening || 0) }),
      },
      f.id,
    );
    bankForm.value = null;
    await load();
  } catch (e) {
    void toastError(e);
  }
}

async function readFile(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (file && importing.value) importing.value.csv = await file.text();
}

async function doImport() {
  if (!importing.value || !selected.value) return;
  try {
    const rows = await feesApi.importStatement(selected.value.id, importing.value.csv);
    await toast(`${rows.length} line(s) imported`);
    importing.value = null;
    lineStatus.value = 'unmatched';
    await loadLines();
  } catch (e) {
    void toastError(e);
  }
}

onMounted(load);
</script>

<style scoped>
.suggest {
  padding: 4px 16px 12px 32px;
  background: var(--ion-color-light);
}
</style>
