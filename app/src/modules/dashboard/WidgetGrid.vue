<template>
  <div v-if="widgets.length" class="widgets">
    <section v-for="w in widgets" :key="w.id" :class="['widget', w.size ?? 'half']">
      <h3 class="eyebrow">{{ title(w) }}</h3>
      <component :is="w.component" />
    </section>
  </div>
</template>

<script setup lang="ts">
import type { DashboardWidget } from '@/core/modules';
import { useWidgetTitle } from './widget-title';

/** Home widgets as flat cards with a small heading: the same look on every persona's home. */
defineProps<{ widgets: readonly DashboardWidget[] }>();
const title = useWidgetTitle();
</script>

<style scoped>
.widgets {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.widget {
  padding: 16px;
  border-radius: 16px;
  background: var(--ion-card-background, var(--ion-item-background, #fff));
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  min-width: 0;
}
.widget.full {
  grid-column: 1 / -1;
}
.eyebrow {
  margin: 0 0 10px;
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ion-color-medium-shade);
}
@media (max-width: 768px) {
  .widgets {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
