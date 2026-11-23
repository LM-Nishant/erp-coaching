<template>
  <div class="empty-state" role="status">
    <ion-icon v-if="icon" :icon="icon" class="icon" aria-hidden="true" />
    <div class="title">{{ title }}</div>
    <p v-if="message" class="message">{{ message }}</p>
    <div v-if="$slots.default" class="actions"><slot /></div>
  </div>
</template>

<script setup lang="ts">
import { IonIcon } from '@ionic/vue';

/**
 * What to show when a list is empty: say what will appear here and, in the default slot, the next step
 * (e.g. an "Add student" button). Never leave a blank page.
 */
withDefaults(defineProps<{ title: string; message?: string; icon?: string }>(), {
  message: undefined,
  icon: undefined,
});
</script>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 6px;
  padding: 32px 16px;
}
.icon {
  font-size: 48px;
  color: var(--ion-color-medium);
}
.title {
  font-size: 17px;
  font-weight: 600;
}
.message {
  margin: 0;
  max-width: 420px;
  color: var(--ion-color-medium-shade);
}
.actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 8px;
}
</style>
