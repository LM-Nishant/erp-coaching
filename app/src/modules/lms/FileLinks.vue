<template>
  <div v-if="files.length" class="files">
    <ion-chip v-for="f in files" :key="f.id" :disabled="!f.url" @click="open(f)">
      <ion-icon :icon="attachOutline" /><ion-label>{{ f.originalName }}</ion-label>
    </ion-chip>
  </div>
</template>

<script setup lang="ts">
import { IonChip, IonIcon, IonLabel } from '@ionic/vue';
import { attachOutline } from 'ionicons/icons';
import type { LmsFileRef } from '@erp/shared';

defineProps<{ files: LmsFileRef[] }>();
const open = (f: LmsFileRef) => f.url && window.open(f.url, '_blank', 'noopener');
</script>
