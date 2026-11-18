<template>
  <div class="role-dashboard">
    <ion-segment v-model="preset" scrollable>
      <ion-segment-button v-for="p in PRESETS" :key="p.value" :value="p.value">
        <ion-label>{{ p.label }}</ion-label>
      </ion-segment-button>
    </ion-segment>
    <ion-progress-bar v-if="loading" type="indeterminate" />
    <p v-if="error" class="muted">{{ error }}</p>

    <template v-if="dash">
      <p class="context">
        <strong>{{ dash.title }}</strong> · {{ dash.scope.label }} · {{ dash.period.label }}
      </p>
      <p v-if="!dash.groups.length" class="muted">Nothing to show for this period yet.</p>
      <section v-for="g in dash.groups" :key="g.key">
        <h3>{{ g.title }}</h3>
        <MetricGrid :metrics="g.metrics" :timezone="dash.period.timezone" />
      </section>
      <ReportTable v-if="dash.branches" :table="dash.branches" :timezone="dash.period.timezone" />
      <div v-if="dash.reports.length" class="shortcuts">
        <ion-button
          v-for="key in dash.reports"
          :key="key"
          size="small"
          fill="outline"
          :router-link="`/reports/${key}?preset=${preset}`"
          >{{ titles[key] ?? humanize(key) }}</ion-button
        >
        <ion-button size="small" fill="clear" router-link="/reports">All reports</ion-button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { IonButton, IonLabel, IonProgressBar, IonSegment, IonSegmentButton } from '@ionic/vue';
import type { ReportDatePreset, ReportKey, RoleDashboardDto } from '@erp/shared';
import { errorMessage } from '@/core/api';
import { reportsApi } from '../api';
import MetricGrid from '../components/MetricGrid.vue';
import ReportTable from '../components/ReportTable.vue';
import { humanize } from '../format';

const PRESETS: { value: ReportDatePreset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'this_week', label: 'This week' },
  { value: 'this_month', label: 'This month' },
  { value: 'this_fy', label: 'This FY' },
];

const preset = ref<ReportDatePreset>('this_month');
const dash = ref<RoleDashboardDto | null>(null);
const titles = ref<Partial<Record<ReportKey, string>>>({});
const loading = ref(false);
const error = ref('');
let requestId = 0;

async function load() {
  const id = ++requestId;
  loading.value = true;
  try {
    const data = await reportsApi.dashboard({ preset: preset.value });
    if (id !== requestId) return;
    dash.value = data;
    error.value = '';
  } catch (e) {
    if (id === requestId) error.value = errorMessage(e);
  } finally {
    if (id === requestId) loading.value = false;
  }
}

async function loadTitles() {
  try {
    titles.value = Object.fromEntries((await reportsApi.catalog()).map((r) => [r.key, r.title]));
  } catch {
    // Shortcuts fall back to readable keys.
  }
}

watch(preset, load);
onMounted(() => Promise.all([load(), loadTitles()]));
</script>

<style scoped>
.context {
  margin: 12px 0 0;
  font-size: 14px;
}
h3 {
  font-size: 15px;
  margin: 16px 0 0;
}
.shortcuts {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 12px;
}
</style>
