<template>
  <AppPage title="Tally export" :on-refresh="load">
    <template #actions>
      <ion-button aria-label="Tally settings and ledger mapping" router-link="/accounting/tally/settings"
        ><ion-icon slot="icon-only" :icon="settingsOutline"
      /></ion-button>
    </template>
    <p class="muted">
      Creates files for TallyPrime (also importable into Tally.ERP 9) from the fee and finance ledger: a
      masters file with the ledgers and a vouchers file. In Tally, import the masters first, then the vouchers
      (TallyPrime: Alt+O › Masters, then Alt+O › Transactions).
    </p>

    <template v-if="canExport">
      <ion-list>
        <ion-item v-if="scopes.length > 1">
          <ion-select v-model="scope" label="Branch" label-placement="stacked">
            <ion-select-option v-for="s in scopes" :key="s.key" :value="s.key">{{
              s.label
            }}</ion-select-option>
          </ion-select>
        </ion-item>
        <ion-item>
          <ion-input v-model="from" type="date" label="From" label-placement="stacked" />
          <ion-input v-model="to" type="date" label="To" label-placement="stacked" />
        </ion-item>
        <ion-item>
          <ion-toggle v-model="onlyNew">Leave out vouchers already exported to this Tally company</ion-toggle>
        </ion-item>
      </ion-list>
      <div class="actions">
        <ion-button :disabled="busy" @click="runPreview">Preview</ion-button>
        <ion-button :disabled="busy || !canCreate" color="success" @click="create">Create export</ion-button>
      </div>
    </template>

    <template v-if="preview">
      <div class="stats">
        <StatCard label="Vouchers" :value="preview.counts.vouchers" :hint="typeSummary(preview.byType)" />
        <StatCard label="Total (debits)" :value="rupees(preview.totalAmount)" />
        <StatCard label="New ledgers" :value="preview.newLedgers.length" hint="Created by the masters file" />
        <StatCard
          label="Exported before"
          :value="preview.counts.alreadyExported"
          :hint="
            preview.counts.changedSinceExport
              ? `${preview.counts.changedSinceExport} changed since`
              : undefined
          "
        />
      </div>
      <p v-if="!preview.companyName" class="muted">
        No Tally company name is set, so Tally imports into the company that is open. Set it in Tally
        settings.
      </p>
      <p v-else class="muted">Tally company: {{ preview.companyName }}</p>
      <ion-list v-if="preview.conflicts.length">
        <ion-list-header color="danger"><ion-label>Fix the ledger mapping first</ion-label></ion-list-header>
        <ion-item v-for="c in preview.conflicts" :key="c.tallyName">
          <ion-label class="ion-text-wrap">
            <h3>{{ c.tallyName }}</h3>
            <p>Mapped under different groups ({{ c.groups.join(', ') }}) by {{ c.accounts.join(', ') }}</p>
          </ion-label>
        </ion-item>
      </ion-list>
      <p v-if="preview.unknownGroups.length" class="warning">
        Create these groups in Tally before importing: {{ preview.unknownGroups.join(', ') }}
      </p>
      <p v-if="!preview.counts.vouchers" class="muted">
        {{
          preview.counts.alreadyExported
            ? 'Everything in this period has already been exported to this Tally company.'
            : 'No accounting entries in this period.'
        }}
      </p>
      <ion-list v-if="preview.newLedgers.length">
        <ion-list-header><ion-label>Ledgers the masters file creates</ion-label></ion-list-header>
        <ion-item v-for="l in preview.newLedgers" :key="l.name">
          <ion-label>{{ l.name }}</ion-label>
          <ion-note slot="end">{{ l.parent }}</ion-note>
        </ion-item>
      </ion-list>
      <ion-list v-if="preview.totals.length">
        <ion-list-header><ion-label>Ledger totals</ion-label></ion-list-header>
        <ion-item v-for="t in preview.totals" :key="t.ledger">
          <ion-label>
            <h3>{{ t.ledger }}</h3>
            <p>{{ t.parent }}</p>
          </ion-label>
          <ion-note slot="end">
            <span v-if="t.debit">Dr {{ rupees(t.debit) }}</span>
            <span v-if="t.credit"> Cr {{ rupees(t.credit) }}</span>
          </ion-note>
        </ion-item>
      </ion-list>
    </template>

    <ion-list>
      <ion-list-header><ion-label>Export history</ion-label></ion-list-header>
      <ion-item v-for="e in history" :key="e.id" button :router-link="`/accounting/tally/exports/${e.id}`">
        <ion-label>
          <h3>{{ periodLabel(e) }} · {{ e.branchName ?? 'All branches' }}</h3>
          <p>
            {{ e.voucherCount }} vouchers · {{ rupees(e.totalAmount) }}
            <span v-if="e.onlyNew"> · new only</span>
          </p>
          <p class="muted">{{ e.createdBy?.name ?? '—' }} · {{ formatDateTime(e.createdAt) }}</p>
        </ion-label>
        <ion-badge v-if="e.laterEntries" slot="end" color="warning">{{ e.laterEntries }} later</ion-badge>
      </ion-item>
      <ion-item v-if="!history.length"><ion-label class="muted">No exports yet.</ion-label></ion-item>
    </ion-list>
    <ion-button v-if="history.length < total" fill="clear" expand="block" @click="more">Load more</ion-button>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import {
  IonBadge,
  IonButton,
  IonIcon,
  IonInput,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonNote,
  IonSelect,
  IonSelectOption,
  IonToggle,
  onIonViewWillEnter,
} from '@ionic/vue';
import { settingsOutline } from 'ionicons/icons';
import type { TallyExportDto, TallyPreviewDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import StatCard from '@/components/StatCard.vue';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { rupees } from '../hr/api';
import { formatDateTime, periodLabel, scopeOptions, tallyApi, typeSummary, type ScopeKey } from './api';

const auth = useAuthStore();
const router = useRouter();
const canExport = computed(() => auth.can('tally.export'));
const scopes = computed(() => scopeOptions(auth.me, auth.activeBranchId));
const scope = ref<ScopeKey | undefined>();
watch(
  scopes,
  (list) => {
    if (!list.some((s) => s.key === scope.value)) scope.value = list[0]?.key;
  },
  { immediate: true },
);

const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = new Date();
const from = ref(iso(new Date(today.getFullYear(), today.getMonth(), 1)));
const to = ref(iso(today));
const onlyNew = ref(true);
const preview = ref<TallyPreviewDto | null>(null);
const busy = ref(false);
const canCreate = computed(() => !!preview.value?.counts.vouchers && !preview.value.conflicts.length);
watch([scope, from, to, onlyNew], () => (preview.value = null));

const history = ref<TallyExportDto[]>([]);
const total = ref(0);
let page = 1;

async function load() {
  try {
    page = 1;
    const res = await tallyApi.exports(page);
    history.value = res.items;
    total.value = res.total;
  } catch (e) {
    void toastError(e);
  }
}

async function more() {
  try {
    const res = await tallyApi.exports(page + 1);
    page += 1;
    history.value = [...history.value, ...res.items.filter((e) => !history.value.some((h) => h.id === e.id))];
    total.value = res.total;
  } catch (e) {
    void toastError(e);
  }
}

async function runPreview() {
  busy.value = true;
  try {
    preview.value = await tallyApi.preview(scope.value, {
      from: from.value,
      to: to.value,
      onlyNew: onlyNew.value,
    });
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

async function create() {
  busy.value = true;
  try {
    const created = await tallyApi.createExport(scope.value, {
      from: from.value,
      to: to.value,
      onlyNew: onlyNew.value,
    });
    await toast(`Export created: ${created.voucherCount} vouchers`);
    preview.value = null;
    await router.push({ name: 'tally-export', params: { id: created.id } });
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

onIonViewWillEnter(load);
</script>

<style scoped>
.actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin: 8px 0 12px;
}
.warning {
  color: var(--ion-color-warning-shade);
}
</style>
