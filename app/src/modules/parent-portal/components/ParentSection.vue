<template>
  <div class="section">
    <h3>{{ section.label }}</h3>
    <div v-if="section.metrics.length" class="metrics">
      <div v-for="m in section.metrics" :key="m.label" class="metric" :class="m.tone ?? 'default'">
        <div class="value">{{ m.value }}</div>
        <div class="label">{{ m.label }}</div>
        <div v-if="m.hint" class="hint">{{ m.hint }}</div>
      </div>
    </div>
    <ion-list v-if="section.items.length" lines="none">
      <ion-item
        v-for="(i, idx) in section.items"
        :key="idx"
        :router-link="i.link"
        :detail="!!i.link"
        :button="!!i.link"
      >
        <ion-label class="ion-text-wrap">
          <h3>{{ i.title }}</h3>
          <p v-if="i.subtitle || i.date">{{ [i.date, i.subtitle].filter(Boolean).join(' · ') }}</p>
        </ion-label>
      </ion-item>
    </ion-list>
  </div>
</template>

<script setup lang="ts">
import { IonItem, IonLabel, IonList } from '@ionic/vue';
import type { ParentPortalSectionDto } from '@erp/shared';

defineProps<{ section: ParentPortalSectionDto }>();
</script>

<style scoped>
.section + .section {
  margin-top: 12px;
}
.section h3 {
  font-size: 0.95rem;
  margin: 4px 0 8px;
}
.metrics {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 8px;
}
.metric {
  border-radius: 8px;
  padding: 8px 10px;
  background: var(--ion-color-light);
}
.metric .value {
  font-size: 1.25rem;
  font-weight: 600;
}
.metric .label,
.metric .hint {
  font-size: 0.8rem;
  color: var(--ion-color-medium);
}
.metric.success .value {
  color: var(--ion-color-success);
}
.metric.warning .value {
  color: var(--ion-color-warning-shade);
}
.metric.danger .value {
  color: var(--ion-color-danger);
}
</style>
