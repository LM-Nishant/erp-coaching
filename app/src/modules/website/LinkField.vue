<template>
  <ion-item>
    <ion-select
      :value="kind"
      :label="label"
      label-placement="stacked"
      interface="popover"
      @ion-change="setKind($event.detail.value)"
    >
      <ion-select-option value="">None</ion-select-option>
      <ion-select-option value="admission">Online admission (self-registration)</ion-select-option>
      <ion-select-option value="enquiry">Enquiry form on this page</ion-select-option>
      <ion-select-option value="page">Another page</ion-select-option>
      <ion-select-option value="checkout">Buy a course online (checkout)</ion-select-option>
      <ion-select-option value="url">Custom URL</ion-select-option>
    </ion-select>
  </ion-item>
  <ion-item v-if="kind === 'page'">
    <ion-select
      :value="modelValue?.slice(5)"
      label="Page"
      label-placement="stacked"
      interface="popover"
      @ion-change="emit('update:modelValue', `page:${$event.detail.value}`)"
    >
      <ion-select-option v-for="p in pages" :key="p.slug" :value="p.slug">{{ p.title }}</ion-select-option>
    </ion-select>
  </ion-item>
  <ion-item v-else-if="kind === 'checkout'">
    <ion-select
      :value="Number(modelValue?.slice(9)) || null"
      label="Course"
      label-placement="stacked"
      interface="popover"
      @ion-change="emit('update:modelValue', `checkout:${$event.detail.value}`)"
    >
      <ion-select-option v-for="c in courses" :key="c.id" :value="c.id">{{ c.name }}</ion-select-option>
    </ion-select>
  </ion-item>
  <ion-item v-else-if="kind === 'url'">
    <ion-input
      :value="modelValue"
      label="URL"
      label-placement="stacked"
      placeholder="https://…, /path, #anchor, tel:, mailto:"
      @ion-input="emit('update:modelValue', String($event.detail.value ?? ''))"
    />
  </ion-item>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { IonInput, IonItem, IonSelect, IonSelectOption } from '@ionic/vue';
import type { NamedRef } from './api';

const props = withDefaults(
  defineProps<{
    modelValue: string | null | undefined;
    pages: { slug: string; title: string }[];
    courses: NamedRef[];
    label?: string;
  }>(),
  { label: 'Button link' },
);
const emit = defineEmits<{ 'update:modelValue': [string | null] }>();

const kind = computed(() => {
  const v = props.modelValue;
  if (!v) return '';
  if (v === 'admission' || v === 'enquiry') return v;
  if (v.startsWith('page:')) return 'page';
  if (v.startsWith('checkout:')) return 'checkout';
  return 'url';
});

function setKind(k: string) {
  if (k === kind.value) return;
  if (k === '') emit('update:modelValue', null);
  else if (k === 'admission' || k === 'enquiry') emit('update:modelValue', k);
  else if (k === 'page') emit('update:modelValue', `page:${props.pages[0]?.slug ?? 'home'}`);
  else if (k === 'checkout')
    emit('update:modelValue', props.courses[0] ? `checkout:${props.courses[0].id}` : null);
  else emit('update:modelValue', 'https://');
}
</script>
