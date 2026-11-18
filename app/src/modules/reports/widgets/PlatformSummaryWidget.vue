<template>
  <div>
    <ion-progress-bar v-if="loading" type="indeterminate" />
    <p v-if="error" class="muted">{{ error }}</p>
    <template v-if="dash">
      <p class="context">{{ dash.period.label }}</p>
      <MetricGrid :metrics="tiles" :timezone="dash.period.timezone" />
      <ion-button size="small" fill="outline" router-link="/reports/platform"
        >Open platform analytics</ion-button
      >
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { IonButton, IonProgressBar } from '@ionic/vue';
import type { SaasDashboardDto } from '@erp/shared';
import { errorMessage } from '@/core/api';
import { reportsApi } from '../api';
import MetricGrid from '../components/MetricGrid.vue';
import type { Metric } from '../format';
import { platformHeadline, platformRevenue, platformUsage } from '../platform';

const dash = ref<SaasDashboardDto | null>(null);
const loading = ref(false);
const error = ref('');

const tiles = computed<Metric[]>(() => {
  const d = dash.value;
  if (!d) return [];
  const pick = (metrics: Metric[], ...keys: string[]) => metrics.filter((m) => keys.includes(m.key));
  return [
    ...platformHeadline(d),
    ...pick(platformRevenue(d), 'mrr'),
    ...pick(platformUsage(d), 'storage', 'ai-tokens'),
  ];
});

onMounted(async () => {
  loading.value = true;
  try {
    dash.value = await reportsApi.saasDashboard({ preset: 'this_month' });
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
});
</script>

<style scoped>
.context {
  margin: 0;
  font-size: 14px;
}
</style>
