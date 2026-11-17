<template>
  <ion-item>
    <ion-select
      :value="modelValue ?? null"
      :label="label"
      label-placement="stacked"
      interface="popover"
      @ion-change="emit('update:modelValue', $event.detail.value)"
    >
      <ion-select-option :value="null">{{ emptyLabel }}</ion-select-option>
      <ion-select-option v-for="o in options" :key="o.id" :value="o.id">{{ o.name }}</ion-select-option>
    </ion-select>
  </ion-item>
</template>

<script setup lang="ts">
import { IonItem, IonSelect, IonSelectOption } from '@ionic/vue';
import type { NamedRef } from './api';

defineProps<{
  modelValue: number | null | undefined;
  label: string;
  emptyLabel: string;
  options: NamedRef[];
}>();
const emit = defineEmits<{ 'update:modelValue': [number | null] }>();
</script>
