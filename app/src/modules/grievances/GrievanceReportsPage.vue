<template>
  <AppPage :title="t('grievances.reports.title')" :on-refresh="load">
    <template #actions>
      <ion-button :disabled="downloading" :aria-label="t('grievances.reports.downloadCsv')" @click="download"
        ><ion-icon slot="icon-only" :icon="downloadOutline"
      /></ion-button>
    </template>

    <ion-list>
      <ion-item
        ><ion-input
          v-model="filters.from"
          type="date"
          :label="t('common.labels.from')"
          label-placement="stacked"
      /></ion-item>
      <ion-item
        ><ion-input v-model="filters.to" type="date" :label="t('common.labels.to')" label-placement="stacked"
      /></ion-item>
      <ion-item>
        <ion-select v-model="filters.categoryId" :label="t('grievances.fields.category')" interface="popover">
          <ion-select-option :value="null">{{ t('common.labels.all') }}</ion-select-option>
          <ion-select-option v-for="c in categories" :key="c.id" :value="c.id">{{
            c.name
          }}</ion-select-option>
        </ion-select>
      </ion-item>
    </ion-list>

    <template v-if="summary">
      <div class="stats">
        <StatCard :label="t('grievances.reports.totalComplaints')" :value="formatNumber(summary.total)" />
        <StatCard
          :label="t('grievances.reports.avgFirstResponse')"
          :value="hours(summary.avgFirstResponseHours)"
        />
        <StatCard :label="t('grievances.reports.avgResolution')" :value="hours(summary.avgResolutionHours)" />
        <StatCard
          :label="t('grievances.reports.slaCompliance')"
          :value="formatPercent(summary.slaComplianceRate)"
        />
        <StatCard :label="t('grievances.slaBreached')" :value="formatNumber(summary.slaBreached)" />
        <StatCard :label="t('grievances.reports.reopened')" :value="formatNumber(summary.reopened)" />
        <StatCard
          :label="t('grievances.reports.avgSatisfaction')"
          :value="
            summary.avgSatisfaction
              ? t('grievances.reports.outOfFive', { n: formatNumber(summary.avgSatisfaction, 1) })
              : '—'
          "
        />
      </div>

      <ion-list>
        <ion-list-header
          ><ion-label>{{ t('grievances.reports.byStatus') }}</ion-label></ion-list-header
        >
        <ion-item v-for="(n, s) in summary.byStatus" :key="s">
          <ion-label>{{ t(statusKey(s)) }}</ion-label><ion-note slot="end">{{ formatNumber(n) }}</ion-note>
        </ion-item>
        <ion-list-header
          ><ion-label>{{ t('grievances.reports.byPriority') }}</ion-label></ion-list-header
        >
        <ion-item v-for="(n, p) in summary.byPriority" :key="p">
          <ion-label>{{ t(priorityKey(p)) }}</ion-label><ion-note slot="end">{{ formatNumber(n) }}</ion-note>
        </ion-item>
        <ion-list-header
          ><ion-label>{{ t('grievances.reports.byCategory') }}</ion-label></ion-list-header
        >
        <ion-item v-for="c in summary.byCategory" :key="c.categoryId">
          <ion-label>
            {{ c.name }}
            <p>{{ t('grievances.reports.avgResolutionValue', { value: hours(c.avgResolutionHours) }) }}</p>
          </ion-label>
          <ion-note slot="end">{{ formatNumber(c.total) }}</ion-note>
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
import { useI18n } from 'vue-i18n';
import type { GrievanceCategoryDto, GrievanceReportSummary } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import StatCard from '@/components/StatCard.vue';
import { saveFile } from '@/core/downloads';
import { formatDuration, formatNumber, formatPercent } from '@/core/format';
import { toastError } from '@/core/toast';
import { grievancesApi, priorityKey, statusKey, type ReportFilters } from './api';

const filters = reactive<ReportFilters>({ from: '', to: '', categoryId: null });
const summary = ref<GrievanceReportSummary | null>(null);
const categories = ref<GrievanceCategoryDto[]>([]);
const downloading = ref(false);

const { t } = useI18n();
const hours = (h: number | null) => formatDuration(h == null ? null : h * 3600);

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
</style>
