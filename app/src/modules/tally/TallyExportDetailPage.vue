<template>
  <AppPage
    :title="exp ? `Tally export #${exp.id}` : 'Tally export'"
    back-href="/accounting/tally"
    :on-refresh="load"
  >
    <template v-if="exp">
      <h2 class="title">{{ periodLabel(exp) }} · {{ exp.branchName ?? 'All branches' }}</h2>
      <p class="muted">
        Created by {{ exp.createdBy?.name ?? '—' }} on {{ formatDateTime(exp.createdAt) }}
        <span v-if="exp.onlyNew"> · vouchers not exported before</span>
      </p>
      <div class="stats">
        <StatCard label="Vouchers" :value="exp.voucherCount" :hint="typeSummary(exp.typeCounts)" />
        <StatCard label="Total (debits)" :value="rupees(exp.totalAmount)" />
        <StatCard label="Ledgers in masters file" :value="exp.ledgerCount" />
        <StatCard
          label="Student dues"
          :value="exp.receivableMode === 'party' ? 'Ledger per student' : 'One control ledger'"
        />
      </div>

      <ion-list v-can="'tally.export'">
        <ion-list-header><ion-label>Files for Tally</ion-label></ion-list-header>
        <ion-item>
          <ion-label class="ion-text-wrap">
            <h3>1. Masters (ledgers)</h3>
            <p>
              TallyPrime: Alt+O (Import) › Masters. Tally.ERP 9: Import of Data › Masters. Creates the
              {{ exp.ledgerCount }} ledgers the vouchers need. For ledgers that already exist, choose Ignore
              Duplicates to keep them as they are.
            </p>
          </ion-label>
          <ion-button slot="end" :disabled="!!downloading" @click="download('masters')">
            <ion-icon slot="start" :icon="downloadOutline" />Masters
          </ion-button>
        </ion-item>
        <ion-item>
          <ion-label class="ion-text-wrap">
            <h3>2. Vouchers</h3>
            <p>
              TallyPrime: Alt+O (Import) › Transactions. Tally.ERP 9: Import of Data › Vouchers. Each voucher
              has a fixed id, so Tally updates it when a file is imported again instead of adding a copy.
            </p>
          </ion-label>
          <ion-button slot="end" :disabled="!!downloading" @click="download('vouchers')">
            <ion-icon slot="start" :icon="downloadOutline" />Vouchers
          </ion-button>
        </ion-item>
        <ion-item lines="none">
          <ion-label class="ion-text-wrap muted">
            Open the company
            <strong>{{ exp.companyName ?? 'you keep these books in' }}</strong> in Tally before importing,
            then compare the ledger totals below with Tally's trial balance for the period.
          </ion-label>
        </ion-item>
      </ion-list>
    </template>

    <template v-if="recon">
      <ion-list>
        <ion-list-header><ion-label>Reconciliation</ion-label></ion-list-header>
        <ion-item lines="none">
          <ion-icon
            slot="start"
            :icon="recon.inSync ? checkmarkCircleOutline : alertCircleOutline"
            :color="recon.inSync ? 'success' : 'warning'"
            aria-hidden="true"
          />
          <ion-label class="ion-text-wrap">
            <h3 v-if="recon.inSync">The app still matches this export.</h3>
            <h3 v-else>The app has changed since this export.</h3>
            <p>
              Exported {{ rupees(recon.exportedTotal) }} · in the app now {{ rupees(recon.currentTotal) }} ·
              checked
              {{ formatDateTime(recon.checkedAt) }}
            </p>
            <p v-if="!recon.inSync">
              Export the period again to send the changes (vouchers keep their ids, so Tally updates them), or
              post them in Tally by hand.
            </p>
          </ion-label>
        </ion-item>
      </ion-list>
      <template v-for="flag in TALLY_RECON_FLAGS" :key="flag">
        <ion-list v-if="byFlag[flag].length">
          <ion-list-header>
            <ion-label>{{ FLAG_LABELS[flag] }}</ion-label>
            <ion-badge color="warning">{{ recon.counts[flag] }}</ion-badge>
          </ion-list-header>
          <ion-item v-for="i in byFlag[flag]" :key="`${flag}:${i.journalKey}`">
            <ion-label class="ion-text-wrap">
              <h3>
                {{ i.voucherType ?? 'Voucher' }} {{ i.voucherNumber ?? i.journalKey }}
                <small class="muted">{{ i.entryDate }}</small>
              </h3>
              <p v-if="i.narration">{{ i.narration }}</p>
              <p v-if="i.reverses">Reverses voucher {{ i.reverses }}</p>
            </ion-label>
            <ion-note slot="end">{{ rupees(i.amount) }}</ion-note>
          </ion-item>
        </ion-list>
      </template>
      <p v-if="recon.truncated" class="muted">Showing the first {{ recon.items.length }} entries.</p>

      <ion-list>
        <ion-list-header>
          <ion-label>Ledger totals: exported and now</ion-label>
          <ion-button v-if="recon.totals.some((t) => t.difference === 0)" @click="allTotals = !allTotals">{{
            allTotals ? 'Only differences' : 'All ledgers'
          }}</ion-button>
        </ion-list-header>
        <ion-item v-for="t in totals" :key="t.ledger">
          <ion-label class="ion-text-wrap">
            <h3>
              {{ t.ledger }} <small class="muted">{{ t.parent }}</small>
            </h3>
            <p>Exported: {{ drCr(t.exportedDebit, t.exportedCredit) }}</p>
            <p>Now: {{ drCr(t.currentDebit, t.currentCredit) }}</p>
          </ion-label>
          <ion-note slot="end" :color="t.difference ? 'danger' : 'success'">{{
            t.difference ? `${t.difference > 0 ? '+' : '−'}${rupees(Math.abs(t.difference))} Dr` : 'Matches'
          }}</ion-note>
        </ion-item>
        <ion-item v-if="!totals.length"
          ><ion-label class="muted">Every ledger total matches the export.</ion-label></ion-item
        >
      </ion-list>
    </template>

    <ion-list v-if="exp?.skipped.length">
      <ion-list-header><ion-label>Left out of the file</ion-label></ion-list-header>
      <ion-item v-for="s in exp.skipped" :key="s.journalKey">
        <ion-label class="ion-text-wrap">
          <h3>
            {{ s.journalKey }} <small class="muted">{{ s.entryDate }}</small>
          </h3>
          <p>{{ s.reason }}</p>
        </ion-label>
      </ion-item>
    </ion-list>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import {
  IonBadge,
  IonButton,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonNote,
  onIonViewWillEnter,
} from '@ionic/vue';
import { alertCircleOutline, checkmarkCircleOutline, downloadOutline } from 'ionicons/icons';
import {
  TALLY_RECON_FLAGS,
  type TallyExportDetailDto,
  type TallyReconciliationDto,
  type TallyReconFlag,
  type TallyReconItemDto,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import StatCard from '@/components/StatCard.vue';
import { toast, toastError } from '@/core/toast';
import { rupees } from '../hr/api';
import { FLAG_LABELS, downloadTallyFile, formatDateTime, periodLabel, tallyApi, typeSummary } from './api';

const route = useRoute();
const exp = ref<TallyExportDetailDto | null>(null);
const recon = ref<TallyReconciliationDto | null>(null);
const allTotals = ref(false);
const downloading = ref<'masters' | 'vouchers' | null>(null);

const byFlag = computed(() => {
  const out = Object.fromEntries(TALLY_RECON_FLAGS.map((f) => [f, []])) as unknown as Record<
    TallyReconFlag,
    TallyReconItemDto[]
  >;
  for (const i of recon.value?.items ?? []) out[i.flag].push(i);
  return out;
});
const totals = computed(() =>
  (recon.value?.totals ?? []).filter((t) => allTotals.value || t.difference !== 0),
);

const drCr = (debit: number, credit: number) =>
  [debit ? `Dr ${rupees(debit)}` : '', credit ? `Cr ${rupees(credit)}` : ''].filter(Boolean).join(' ') || '—';

async function load() {
  const id = Number(route.params.id);
  try {
    [exp.value, recon.value] = await Promise.all([tallyApi.export(id), tallyApi.reconciliation(id)]);
  } catch (e) {
    void toastError(e);
  }
}

async function download(kind: 'masters' | 'vouchers') {
  if (!exp.value) return;
  downloading.value = kind;
  try {
    const message = await downloadTallyFile(exp.value.id, kind);
    if (message) await toast(message);
  } catch (e) {
    void toastError(e);
  } finally {
    downloading.value = null;
  }
}

onIonViewWillEnter(load);
</script>

<style scoped>
.title {
  margin: 4px 0;
  font-size: 1.1rem;
}
</style>
