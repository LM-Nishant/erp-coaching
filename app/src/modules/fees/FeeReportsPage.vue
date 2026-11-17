<template>
  <AppPage title="Fee reports" :on-refresh="load">
    <ion-segment v-model="kind" @ion-change="load">
      <ion-segment-button value="daily-cash">Daily cash</ion-segment-button>
      <ion-segment-button value="collections">Collections</ion-segment-button>
      <ion-segment-button value="outstanding">Outstanding dues</ion-segment-button>
    </ion-segment>
    <ion-item>
      <template v-if="kind === 'daily-cash'">
        <ion-input v-model="day" type="date" label="Date" label-placement="stacked" @ion-change="load" />
      </template>
      <template v-else-if="kind === 'collections'">
        <ion-input v-model="from" type="date" label="From" label-placement="stacked" @ion-change="load" />
        <ion-input v-model="to" type="date" label="To" label-placement="stacked" @ion-change="load" />
      </template>
      <template v-else>
        <ion-input v-model="day" type="date" label="As of" label-placement="stacked" @ion-change="load" />
      </template>
      <ion-buttons slot="end" v-can="'fees.export'">
        <ion-button @click="download('csv')">CSV</ion-button>
        <ion-button @click="download('xls')">Excel</ion-button>
      </ion-buttons>
    </ion-item>

    <template v-if="kind === 'daily-cash' && cash">
      <div class="stats">
        <StatCard label="Opening cash" :value="rupees(cash.opening)" />
        <StatCard label="Cash in" :value="rupees(cash.cashIn)" />
        <StatCard label="Cash out" :value="rupees(cash.cashOut)" />
        <StatCard label="Closing cash" :value="rupees(cash.closing)" />
        <StatCard label="All collections" :value="rupees(cash.totalCollections)" />
      </div>
      <ion-list>
        <ion-list-header>Collections by mode</ion-list-header>
        <ion-item v-for="(amt, m) in cash.collectionsByMode" :key="m">
          <ion-label>{{ MODE_LABELS[m] ?? m }}</ion-label><ion-note slot="end">{{ rupees(amt) }}</ion-note>
        </ion-item>
        <ion-list-header>Cash book</ion-list-header>
        <ion-item v-for="(r, i) in cash.rows" :key="i">
          <ion-label>{{ r.narration }}</ion-label>
          <ion-note slot="end">{{ r.in ? `+${rupees(r.in)}` : `−${rupees(r.out)}` }}</ion-note>
        </ion-item>
      </ion-list>
    </template>

    <template v-else-if="kind === 'collections' && collections">
      <div class="stats">
        <StatCard label="Collected" :value="rupees(collections.totals.amount)" />
        <StatCard label="Refunded" :value="rupees(collections.totals.refunded)" />
        <StatCard label="Gateway charges" :value="rupees(collections.totals.gatewayCharges)" />
        <StatCard label="Net" :value="rupees(collections.totals.net)" />
      </div>
      <ion-list>
        <ion-item v-for="(r, i) in collections.items" :key="i">
          <ion-label>
            <h3>
              {{ r.student }} <small class="muted">{{ r.admissionNumber }}</small>
            </h3>
            <p>{{ r.date }} · {{ r.receiptNo }} · {{ r.mode }} {{ r.reference }}</p>
          </ion-label>
          <ion-note slot="end">{{ rupees(r.amount) }}</ion-note>
        </ion-item>
      </ion-list>
    </template>

    <template v-else-if="kind === 'outstanding' && dues">
      <div class="stats">
        <StatCard label="Outstanding" :value="rupees(dues.totals.balance)" />
        <StatCard label="Overdue" :value="rupees(dues.totals.overdue)" />
      </div>
      <ion-list>
        <ion-item
          v-for="r in dues.items"
          :key="r.accountId"
          :router-link="`/fees/accounts/${r.accountId}`"
          detail
        >
          <ion-label>
            <h3>
              {{ r.student }} <small class="muted">{{ r.admissionNumber }} · {{ r.mobile }}</small>
            </h3>
            <p>
              {{ r.title }}<span v-if="r.oldestDueDate"> · overdue since {{ r.oldestDueDate }}</span>
            </p>
          </ion-label>
          <ion-note slot="end" :color="r.overdue ? 'danger' : undefined">{{ rupees(r.balance) }}</ion-note>
        </ion-item>
      </ion-list>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  IonButton,
  IonButtons,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonNote,
  IonSegment,
  IonSegmentButton,
} from '@ionic/vue';
import AppPage from '@/components/AppPage.vue';
import StatCard from '@/components/StatCard.vue';
import { toastError } from '@/core/toast';
import { rupees, todayIso } from '../hr/api';
import { MODE_LABELS, downloadFeesReport, feesApi, type Query } from './api';

interface DailyCash {
  opening: number;
  cashIn: number;
  cashOut: number;
  closing: number;
  totalCollections: number;
  collectionsByMode: Record<string, number>;
  rows: { narration: string | null; in: number; out: number }[];
}
interface Collections {
  items: {
    date: string;
    receiptNo: string;
    student: string;
    admissionNumber: string;
    mode: string;
    reference: string;
    amount: number;
  }[];
  totals: { amount: number; refunded: number; gatewayCharges: number; net: number };
}
interface Outstanding {
  items: {
    accountId: number;
    student: string;
    admissionNumber: string;
    mobile: string;
    title: string;
    balance: number;
    overdue: number;
    oldestDueDate: string | null;
  }[];
  totals: { balance: number; overdue: number };
}

const kind = ref<'daily-cash' | 'collections' | 'outstanding'>('daily-cash');
const day = ref(todayIso());
const from = ref(`${todayIso().slice(0, 8)}01`);
const to = ref(todayIso());
const cash = ref<DailyCash | null>(null);
const collections = ref<Collections | null>(null);
const dues = ref<Outstanding | null>(null);

const query = (): Query =>
  kind.value === 'daily-cash'
    ? { date: day.value }
    : kind.value === 'collections'
      ? { from: from.value, to: to.value }
      : { asOf: day.value };

async function load() {
  try {
    if (kind.value === 'daily-cash') cash.value = await feesApi.report<DailyCash>(kind.value, query());
    else if (kind.value === 'collections')
      collections.value = await feesApi.report<Collections>(kind.value, query());
    else dues.value = await feesApi.report<Outstanding>(kind.value, query());
  } catch (e) {
    void toastError(e);
  }
}

async function download(format: 'csv' | 'xls') {
  try {
    await downloadFeesReport(`reports/${kind.value}`, query(), format);
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
</style>
