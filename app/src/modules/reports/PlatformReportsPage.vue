<template>
  <AppPage title="Platform analytics" :on-refresh="load">
    <template #actions>
      <ion-button :disabled="exporting || !!rangeError || !dash" @click="exportOverview">
        <ion-icon slot="start" :icon="downloadOutline" />Export
      </ion-button>
    </template>

    <p class="muted intro">
      Institutes, users, subscriptions, revenue and resource usage across the platform.
    </p>
    <ReportFilters
      v-model="state"
      :options="options"
      :allowed="['date']"
      :current="dash ? { from: dash.period.from, to: dash.period.to } : null"
    />
    <ion-progress-bar v-if="loading" type="indeterminate" />

    <template v-if="dash">
      <p class="context"><strong>All institutes</strong> · {{ dash.period.label }}</p>

      <h2>Platform</h2>
      <MetricGrid :metrics="platformHeadline(dash)" :timezone="tz" />

      <h2>Subscriptions</h2>
      <MetricGrid :metrics="platformSubscriptions(dash)" :timezone="tz" />
      <ReportTable :table="plansTable(dash)" :timezone="tz" />

      <h2>Revenue</h2>
      <MetricGrid :metrics="platformRevenue(dash)" :timezone="tz" />
      <p class="muted note">{{ revenueNote(dash) }}</p>

      <h2>Resource usage</h2>
      <MetricGrid :metrics="platformUsage(dash)" :timezone="tz" />
      <ReportTable :table="aiFeatureTable(dash)" :timezone="tz" />

      <ReportTable :table="institutesTable(dash)" :timezone="tz" />
      <p class="muted note">Generated {{ displayDateTime(dash.generatedAt, tz) }} ({{ tz }})</p>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { IonButton, IonIcon, IonProgressBar } from '@ionic/vue';
import { downloadOutline } from 'ionicons/icons';
import type { SaasDashboardDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { saveFile } from '@/core/downloads';
import { toast, toastError } from '@/core/toast';
import { reportsApi } from './api';
import MetricGrid from './components/MetricGrid.vue';
import ReportFilters from './components/ReportFilters.vue';
import ReportTable from './components/ReportTable.vue';
import { pickExportFormat } from './exportUi';
import {
  customRangeError,
  stateFromQuery,
  stateToQuery,
  toFiltersInput,
  type ReportFilterState,
} from './filters';
import { displayDateTime } from './format';
import {
  aiFeatureTable,
  institutesTable,
  PLATFORM_TIMEZONE,
  platformFilterOptions,
  platformHeadline,
  platformRevenue,
  platformSubscriptions,
  platformUsage,
  plansTable,
  revenueNote,
  saasExportFileName,
} from './platform';

const route = useRoute();
const router = useRouter();

const options = platformFilterOptions();
const state = ref<ReportFilterState>({
  ...stateFromQuery(route.query, options.defaultPreset),
  branchId: null,
  courseId: null,
  batchId: null,
});
const dash = ref<SaasDashboardDto | null>(null);
const loading = ref(false);
const exporting = ref(false);
let requestId = 0;

const tz = computed(() => dash.value?.period.timezone ?? PLATFORM_TIMEZONE);
const rangeError = computed(() => customRangeError(state.value));
const period = () => toFiltersInput(state.value, ['date']);

async function load() {
  if (rangeError.value) return;
  const id = ++requestId;
  loading.value = true;
  try {
    const data = await reportsApi.saasDashboard(period());
    if (id === requestId) dash.value = data;
  } catch (e) {
    if (id === requestId) void toastError(e);
  } finally {
    if (id === requestId) loading.value = false;
  }
}

async function exportOverview() {
  const format = await pickExportFormat('Export platform overview');
  if (!format || !dash.value) return;
  exporting.value = true;
  try {
    const file = await reportsApi.saasExport(format, period());
    const name = file.fileName ?? saasExportFileName(dash.value, format);
    if ((await saveFile(file.blob, name)) === 'downloaded') await toast(`Downloaded ${name}`);
  } catch (e) {
    void toastError(e);
  } finally {
    exporting.value = false;
  }
}

watch(
  state,
  (s) => {
    if (customRangeError(s)) return;
    void router.replace({ query: stateToQuery(s) });
    void load();
  },
  { deep: true },
);

onMounted(load);
</script>

<style scoped>
.intro {
  margin-top: 0;
}
.context {
  margin: 16px 0 0;
  font-size: 14px;
}
h2 {
  font-size: 18px;
  margin: 24px 0 0;
}
.note {
  font-size: 12px;
}
</style>
