<template>
  <ion-item>
    <ion-select
      :value="kind"
      :label="label ?? t('website.link.buttonLink')"
      label-placement="stacked"
      interface="popover"
      @ion-change="setKind($event.detail.value)"
    >
      <ion-select-option value="">{{ t('common.labels.none') }}</ion-select-option>
      <ion-select-option value="admission">{{ t('website.link.admission') }}</ion-select-option>
      <ion-select-option value="enquiry">{{ t('website.link.enquiry') }}</ion-select-option>
      <ion-select-option value="page">{{ t('website.link.page') }}</ion-select-option>
      <ion-select-option value="checkout">{{ t('website.link.checkout') }}</ion-select-option>
      <ion-select-option value="url">{{ t('website.link.url') }}</ion-select-option>
    </ion-select>
  </ion-item>
  <ion-item v-if="kind === 'page'">
    <ion-select
      :value="modelValue?.slice(5)"
      :label="t('website.link.pageLabel')"
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
      :label="t('website.editor.course')"
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
      :label="t('website.link.urlLabel')"
      label-placement="stacked"
      placeholder="https://…, /path, #anchor, tel:, mailto:"
      @ion-input="emit('update:modelValue', String($event.detail.value ?? ''))"
    />
  </ion-item>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { IonInput, IonItem, IonSelect, IonSelectOption } from '@ionic/vue';
import type { NamedRef } from './api';

const props = withDefaults(
  defineProps<{
    modelValue: string | null | undefined;
    pages: { slug: string; title: string }[];
    courses: NamedRef[];
    label?: string;
  }>(),
  { label: undefined },
);
const { t } = useI18n();
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
