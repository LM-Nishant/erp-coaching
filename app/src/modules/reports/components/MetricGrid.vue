<template>
  <div class="metrics">
    <ion-card v-for="m in metrics" :key="m.key" class="metric">
      <ion-card-content>
        <div class="label">{{ m.label }}</div>
        <div class="value" :style="{ color: `var(--ion-color-${m.tone ?? 'primary'})` }">
          {{ metricText(m, timezone) }}
        </div>
        <div v-if="m.hint" class="hint">{{ m.hint }}</div>
      </ion-card-content>
    </ion-card>
  </div>
</template>

<script setup lang="ts">
import { IonCard, IonCardContent } from '@ionic/vue';
import { metricText, type Metric } from '../format';

defineProps<{ metrics: Metric[]; timezone: string }>();
</script>

<style scoped>
.metrics {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 12px;
  margin: 12px 0;
}
.metric {
  margin: 0;
  height: 100%;
}
.label {
  font-size: 12px;
  text-transform: uppercase;
  color: var(--ion-color-medium);
}
.value {
  font-size: 22px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.hint {
  font-size: 12px;
  color: var(--ion-color-medium);
}
</style>
