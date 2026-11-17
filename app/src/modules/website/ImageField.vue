<template>
  <ion-item>
    <ion-thumbnail v-if="previewUrl" slot="start"><img :src="previewUrl" alt="" /></ion-thumbnail>
    <ion-label>
      <h3>{{ label }}</h3>
      <p>{{ modelValue ? `Image #${modelValue}` : 'No image' }}</p>
    </ion-label>
    <ion-button slot="end" fill="outline" size="small" :disabled="uploading" @click="input?.click()">
      {{ modelValue ? 'Replace' : 'Upload' }}
    </ion-button>
    <ion-button
      v-if="modelValue && clearable"
      slot="end"
      fill="clear"
      color="danger"
      size="small"
      @click="clear"
    >
      <ion-icon slot="icon-only" :icon="closeCircleOutline" />
    </ion-button>
    <input ref="input" type="file" accept="image/*" hidden @change="pick" />
  </ion-item>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { IonButton, IonIcon, IonItem, IonLabel, IonThumbnail } from '@ionic/vue';
import { closeCircleOutline } from 'ionicons/icons';
import { toastError } from '@/core/toast';
import { websiteApi } from './api';

withDefaults(defineProps<{ modelValue: number | null | undefined; label?: string; clearable?: boolean }>(), {
  label: 'Image',
  clearable: true,
});
const emit = defineEmits<{ 'update:modelValue': [number | null] }>();
const input = ref<HTMLInputElement | null>(null);
const uploading = ref(false);
const previewUrl = ref<string | null>(null);

async function pick(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0];
  if (!file) return;
  uploading.value = true;
  try {
    const f = await websiteApi.upload(file);
    previewUrl.value = f.url;
    emit('update:modelValue', f.id);
  } catch (e) {
    await toastError(e);
  } finally {
    uploading.value = false;
    if (input.value) input.value.value = '';
  }
}

function clear() {
  previewUrl.value = null;
  emit('update:modelValue', null);
}
</script>
