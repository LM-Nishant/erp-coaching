<template>
  <AppPage title="Grievance reports" :on-refresh="load">
    <template #actions>
      <ion-button :disabled="downloading" aria-label="Download CSV" @click="download"
        ><ion-icon slot="icon-only" :icon="downloadOutline"
      /></ion-button>
    </template>

    <ion-list>
      <ion-item
        ><ion-input v-model="filters.from" type="date" label="From" label-placement="stacked"
      /></ion-item>
      <ion-item><ion-input v-model="filters.to" type="date" label="To" label-placement="stacked" /></ion-item>
      <ion-item>
        <ion-select v-model="filters.categoryId" label="Category" interface="popover">
          <ion-select-option :value="null">All</ion-select-option>
          <ion-select-option v-for="c in categories" :key="c.id" :value="c.id">{{
            c.name
          }}</ion-select-option>
        </ion-select>
      </ion-item>
    </ion-list>

    <template v-if="summary">
      <div class="stats">
        <StatCard label="Total complaints" :value="summary.total" />
        <StatCard label="Avg first response" :value="hours(summary.avgFirstResponseHours)" />
        <StatCard label="Avg resolution" :value="hours(summary.avgResolutionHours)" />
        <StatCard label="SLA compliance" :value="pct(summary.slaComplianceRate)" />
        <StatCard label="SLA breached" :value="summary.slaBreached" />
        <StatCard label="Reopened" :value="summary.reopened" />
        <StatCard
          label="Avg satisfaction"
          :value="summary.avgSatisfaction ? `${summary.avgSatisfaction} / 5` : '—'"
        />
      </div>

      <ion-list>
        <ion-list-header><ion-label>By status</ion-label></ion-list-header>
        <ion-item v-for="(n, s) in summary.byStatus" :key="s">
          <ion-label class="cap">{{ statusLabel(s) }}</ion-label><ion-note slot="end">{{ n }}</ion-note>
        </ion-item>
        <ion-list-header><ion-label>By priority</ion-label></ion-list-header>
        <ion-item v-for="(n, p) in summary.byPriority" :key="p">
          <ion-label class="cap">{{ p }}</ion-label><ion-note slot="end">{{ n }}</ion-note>
        </ion-item>
        <ion-list-header><ion-label>By category</ion-label></ion-list-header>
        <ion-item v-for="c in summary.byCategory" :key="c.categoryId">
          <ion-label>
            {{ c.name }}
            <p>Avg resolution {{ hours(c.avgResolutionHours) }}</p>
          </ion-label>
          <ion-note slot="end">{{ c.total }}</ion-note>
        </ion-item>
      </ion-list>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref, watch } from 'vue';
import {
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
} from '@ionic/vue';
import { downloadOutline } from 'ionicons/icons';
import type { GrievanceCategoryDto, GrievanceReportSummary } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import StatCard from '@/components/StatCard.vue';
import { saveFile } from '@/core/downloads';
import { toastError } from '@/core/toast';
import { grievancesApi, statusLabel, type ReportFilters } from './api';

const filters = reactive<ReportFilters>({ from: '', to: '', categoryId: null });
const summary = ref<GrievanceReportSummary | null>(null);
const categories = ref<GrievanceCategoryDto[]>([]);
const downloading = ref(false);

const hours = (h: number | null) =>
  h == null ? '—' : h < 48 ? `${h.toFixed(1)} h` : `${(h / 24).toFixed(1)} d`;
const pct = (r: number | null) => (r == null ? '—' : `${r}%`);

/** `to` is inclusive of the whole selected day. */
const query = () => ({
  from: filters.from || undefined,
  to: filters.to ? new Date(`${filters.to}T23:59:59.999`).toISOString() : undefined,
  categoryId: filters.categoryId,
});

async function load() {
  try {
    summary.value = await grievancesApi.summary(query());
  } catch (e) {
    await toastError(e);
  }
}

async function download() {
  downloading.value = true;
  try {
    const csv = await grievancesApi.exportCsv(query());
    await saveFile(csv, `grievances-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv');
  } catch (e) {
    await toastError(e);
  } finally {
    downloading.value = false;
  }
}

onMounted(async () => {
  await load();
  categories.value = await grievancesApi.categories(true).catch(() => []);
});
watch(filters, load);
</script>

<style scoped>
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 8px;
}
.cap {
  text-transform: capitalize;
}
</style>
