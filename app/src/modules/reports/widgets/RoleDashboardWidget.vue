<template>
  <div class="role-dashboard">
    <div class="presets" role="radiogroup" :aria-label="t('reports.filters.period')">
      <ion-chip
        v-for="p in PRESETS"
        :key="p.value"
        role="radio"
        :aria-checked="preset === p.value"
        :color="preset === p.value ? 'primary' : 'medium'"
        :outline="preset !== p.value"
        @click="preset = p.value"
        >{{ p.label }}</ion-chip
      >
    </div>
    <ion-progress-bar v-if="loading" type="indeterminate" />
    <p v-if="error" class="muted">{{ error }}</p>

    <template v-if="dash">
      <p class="context">
        <strong>{{ dash.title }}</strong> · {{ dash.scope.label }} · {{ dash.period.label }}
      </p>
      <p v-if="!dash.groups.length" class="muted">{{ t('reports.widget.empty') }}</p>
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
        <ion-button size="small" fill="clear" router-link="/reports">{{
          t('reports.widget.allReports')
        }}</ion-button>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { IonButton, IonChip, IonProgressBar } from '@ionic/vue';
import type { ReportDatePreset, ReportKey, RoleDashboardDto } from '@erp/shared';
import { errorMessage } from '@/core/api';
import { reportsApi } from '../api';
import MetricGrid from '../components/MetricGrid.vue';
import ReportTable from '../components/ReportTable.vue';
import { humanize } from '../format';

const { t } = useI18n();

const PRESETS = computed<{ value: ReportDatePreset; label: string }[]>(() => [
  { value: 'today', label: t('reports.presets.today') },
  { value: 'this_week', label: t('reports.presets.this_week') },
  { value: 'this_month', label: t('reports.presets.this_month') },
  { value: 'this_fy', label: t('reports.presets.thisFyShort') },
]);

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
.presets {
  display: flex;
  flex-wrap: wrap;
}
.presets ion-chip {
  margin: 0 8px 8px 0;
}
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
