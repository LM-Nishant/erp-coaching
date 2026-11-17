<template>
  <div class="doc-upload">
    <ion-select v-model="docType" label="Document type" label-placement="stacked" interface="popover">
      <ion-select-option v-for="t in DOCUMENT_TYPES" :key="t" :value="t">{{ humanize(t) }}</ion-select-option>
    </ion-select>
    <ion-input v-model="title" label="Title (optional)" label-placement="stacked" />
    <input ref="input" type="file" accept="image/*,application/pdf" @change="pick" />
    <ion-button size="small" :disabled="!file || busy" @click="submit">Upload</ion-button>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { IonButton, IonInput, IonSelect, IonSelectOption } from '@ionic/vue';
import { DOCUMENT_TYPES, humanize } from './api';

defineProps<{ busy?: boolean }>();
const emit = defineEmits<{ upload: [{ file: File; docType: string; title: string }] }>();
const docType = ref('id_proof');
const title = ref('');
const file = ref<File | null>(null);
const input = ref<HTMLInputElement>();

function pick(e: Event) {
  file.value = (e.target as HTMLInputElement).files?.[0] ?? null;
}

function submit() {
  if (!file.value) return;
  emit('upload', { file: file.value, docType: docType.value, title: title.value.trim() });
  file.value = null;
  title.value = '';
  if (input.value) input.value.value = '';
}
</script>

<style scoped>
.doc-upload {
  display: grid;
  gap: 8px;
}
</style>
