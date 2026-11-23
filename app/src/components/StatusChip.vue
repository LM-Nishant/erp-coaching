<template>
  <span class="status-chip" :class="tone">
    <ion-icon v-if="icon" :icon="icon" aria-hidden="true" />
    {{ label }}
  </span>
</template>

<script setup lang="ts">
import { IonIcon } from '@ionic/vue';

/**
 * A plain-language status ("Due soon", "Paid", "Absent") instead of a raw code. Pick the words with
 * `t('common.status.*')` or your module's keys; the tone carries the meaning, so keep the label short.
 */
withDefaults(
  defineProps<{
    label: string;
    tone?: 'success' | 'warning' | 'danger' | 'primary' | 'medium';
    icon?: string;
  }>(),
  { tone: 'medium', icon: undefined },
);
</script>

<style scoped>
.status-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border-radius: 12px;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  white-space: nowrap;
  background: rgba(var(--ion-color-medium-rgb), 0.15);
  color: var(--ion-color-medium-shade);
}
.success {
  background: rgba(var(--ion-color-success-rgb), 0.15);
  color: var(--ion-color-success-shade);
}
.warning {
  background: rgba(var(--ion-color-warning-rgb), 0.18);
  color: var(--ion-color-warning-shade);
}
.danger {
  background: rgba(var(--ion-color-danger-rgb), 0.12);
  color: var(--ion-color-danger-shade);
}
.primary {
  background: rgba(var(--ion-color-primary-rgb), 0.12);
  color: var(--ion-color-primary-shade);
}
</style>
