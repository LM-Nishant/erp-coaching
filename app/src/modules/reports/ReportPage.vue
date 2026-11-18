<template>
  <AppPage :title="title" back-href="/reports" :on-refresh="load">
    <template #actions>
      <ion-button v-if="item?.exportable" :disabled="exporting || !!rangeError" @click="exportReport">
        <ion-icon slot="start" :icon="downloadOutline" />Export
      </ion-button>
    </template>

    <p v-if="!known" class="muted">This report does not exist.</p>
    <p v-else-if="loaded && !item" class="muted">This report is not available for your role or plan.</p>

    <template v-if="item && options">
      <p class="muted description">{{ item.description }}</p>
      <ReportFilters
        v-model="state"
        :options="options"
        :allowed="item.filters"
        :current="result ? { from: result.period.from, to: result.period.to } : null"
      />
    </template>
    <ion-progress-bar v-if="loading" type="indeterminate" />

    <template v-if="result">
      <p class="context">
        <strong>{{ result.scope.label }}</strong> · {{ result.period.label }}
        <span v-if="applied"> · {{ applied }}</span>
      </p>
      <MetricGrid :metrics="result.summary" :timezone="result.period.timezone" />
      <ReportTable v-for="t in result.tables" :key="t.key" :table="t" :timezone="result.period.timezone" />
      <ul v-if="result.notes.length" class="notes muted">
        <li v-for="(n, i) in result.notes" :key="i">{{ n }}</li>
      </ul>
      <p class="muted generated">
        Generated {{ displayDateTime(result.generatedAt, result.period.timezone) }} ({{
          result.period.timezone
        }})
      </p>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { IonButton, IonIcon, IonProgressBar, toastController } from '@ionic/vue';
import { downloadOutline } from 'ionicons/icons';
import {
  REPORT_KEYS,
  type ReportCatalogItemDto,
  type ReportFilterOptionsDto,
  type ReportKey,
  type ReportResultDto,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toastError } from '@/core/toast';
import { openExport, reportsApi } from './api';
import MetricGrid from './components/MetricGrid.vue';
import ReportFilters from './components/ReportFilters.vue';
import ReportTable from './components/ReportTable.vue';
import { pickExportFormat } from './exportUi';
import {
  customRangeError,
  emptyFilterState,
  reconcileState,
  stateFromQuery,
  stateToQuery,
  toFiltersInput,
  type ReportFilterState,
} from './filters';
import { displayDateTime } from './format';

const route = useRoute();
const router = useRouter();

const key = ref(String(route.params.key ?? '') as ReportKey);
const known = computed(() => (REPORT_KEYS as readonly string[]).includes(key.value));
const item = ref<ReportCatalogItemDto | null>(null);
const options = ref<ReportFilterOptionsDto | null>(null);
const state = ref<ReportFilterState>(emptyFilterState());
const result = ref<ReportResultDto | null>(null);
const loaded = ref(false);
const loading = ref(false);
const exporting = ref(false);
let ready = false;
let requestId = 0;

const title = computed(() => item.value?.title ?? result.value?.title ?? 'Report');
const rangeError = computed(() => customRangeError(state.value));
const filtersInput = computed(() =>
  toFiltersInput(state.value, item.value?.filters, options.value?.audience),
);
const applied = computed(() => {
  const f = result.value?.filters;
  if (!f) return '';
  return [f.courseName && `Course: ${f.courseName}`, f.batchName && `Batch: ${f.batchName}`]
    .filter(Boolean)
    .join(' · ');
});

async function init() {
  if (!known.value) return;
  try {
    const [catalog, opts] = await Promise.all([reportsApi.catalog(), reportsApi.filterOptions()]);
    options.value = opts;
    item.value = catalog.find((c) => c.key === key.value) ?? null;
    ready = true;
    // Triggers the state watcher, which normalises the URL and loads the report.
    state.value = reconcileState(stateFromQuery(route.query, opts.defaultPreset), opts);
  } catch (e) {
    void toastError(e);
  } finally {
    loaded.value = true;
  }
}

async function load() {
  if (!ready || !item.value || rangeError.value) return;
  const id = ++requestId;
  loading.value = true;
  try {
    const data = await reportsApi.report(key.value, filtersInput.value);
    if (id === requestId) result.value = data;
  } catch (e) {
    if (id === requestId) void toastError(e);
  } finally {
    if (id === requestId) loading.value = false;
  }
}

async function exportReport() {
  const format = await pickExportFormat(`Export ${title.value}`);
  if (!format) return;
  exporting.value = true;
  try {
    const exp = await reportsApi.createExport(key.value, format, filtersInput.value);
    if (exp.status === 'ready') await openExport(exp.id);
    else await queuedToast();
  } catch (e) {
    void toastError(e);
  } finally {
    exporting.value = false;
  }
}

async function queuedToast() {
  const t = await toastController.create({
    message:
      'This export is large, so it is being prepared in the background. We will notify you when it is ready.',
    color: 'medium',
    duration: 6000,
    position: 'top',
    buttons: [{ text: 'View exports', handler: () => void router.push('/reports/exports') }],
  });
  await t.present();
}

// Filter changes update the URL (shareable) and reload once the filters are usable.
watch(
  state,
  (s) => {
    if (!ready || customRangeError(s)) return;
    void router.replace({ query: stateToQuery(s) });
    void load();
  },
  { deep: true },
);

onMounted(init);
</script>

<style scoped>
.description {
  margin-top: 0;
}
.context {
  margin: 16px 0 0;
  font-size: 14px;
}
.notes {
  font-size: 13px;
  padding-left: 18px;
}
.generated {
  font-size: 12px;
}
</style>
