<template>
  <ion-card class="stat">
    <ion-card-content>
      <div class="label">{{ label }}</div>
      <div class="value">{{ value }}</div>
      <div v-if="hint" class="hint">{{ hint }}</div>
    </ion-card-content>
  </ion-card>
</template>

<script setup lang="ts">
import { IonCard, IonCardContent } from '@ionic/vue';

defineProps<{ label: string; value: string | number; hint?: string }>();
</script>

<style scoped>
.stat {
  margin: 0;
  height: 100%;
}
.label {
  font-size: 12px;
  text-transform: uppercase;
  color: var(--ion-color-medium);
}
.value {
  font-size: 26px;
  font-weight: 600;
  color: var(--ion-color-primary);
}
.hint {
  font-size: 12px;
  color: var(--ion-color-medium);
}
</style>
