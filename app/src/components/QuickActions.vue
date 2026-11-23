<template>
  <nav class="quick-actions" :aria-label="label">
    <button v-for="a in actions" :key="a.id" type="button" class="action" @click="run(a)">
      <ion-icon :icon="a.icon" aria-hidden="true" />
      <span class="title">{{ a.title }}</span>
      <span v-if="a.badge" class="badge">{{ a.badge }}</span>
    </button>
  </nav>
</template>

<script lang="ts">
import type { RouteLocationRaw } from 'vue-router';

/** One big button on a home page: opens `to` or runs `onClick`. */
export interface QuickAction {
  /** Unique within the grid, `<module>.<action>`, e.g. `fees.collect`. */
  id: string;
  title: string;
  /** ionicons icon. */
  icon: string;
  to?: RouteLocationRaw;
  onClick?: () => void;
  /** Count shown on the button, e.g. doubts waiting for an answer; hidden when 0. */
  badge?: number | string;
}
</script>

<script setup lang="ts">
import { IonIcon, useIonRouter } from '@ionic/vue';

/** Grid of quick actions (3 per row on phones) for persona homes; filter by permission before passing. */
withDefaults(defineProps<{ actions: QuickAction[]; label?: string }>(), { label: 'Quick actions' });
const ionRouter = useIonRouter();

function run(a: QuickAction) {
  if (a.onClick) a.onClick();
  else if (a.to) ionRouter.push(a.to);
}
</script>

<style scoped>
.quick-actions {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  gap: 8px;
}
.action {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 80px;
  padding: 10px 6px;
  border: 0;
  border-radius: 14px;
  background: var(--ion-card-background, var(--ion-item-background, #fff));
  color: var(--ion-text-color);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  font: inherit;
  cursor: pointer;
}
.action ion-icon {
  font-size: 26px;
  color: var(--ion-color-primary);
}
.title {
  font-size: 14px;
  font-weight: 600;
  text-align: center;
}
.badge {
  position: absolute;
  top: 6px;
  right: 8px;
  min-width: 20px;
  padding: 1px 6px;
  border-radius: 10px;
  background: var(--ion-color-danger);
  color: var(--ion-color-danger-contrast);
  font-size: 12px;
  font-weight: 700;
}
</style>
