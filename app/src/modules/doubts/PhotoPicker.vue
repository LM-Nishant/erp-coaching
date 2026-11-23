<template>
  <div class="photo-picker">
    <input
      ref="input"
      class="hidden-input"
      type="file"
      accept="image/*"
      capture="environment"
      data-testid="doubt-photo-input"
      @change="pick"
    />
    <div v-if="preview" class="preview">
      <img :src="preview" :alt="t('doubts.detail.photo')" />
      <ion-button fill="clear" color="danger" size="small" @click="clear">
        <ion-icon slot="start" :icon="closeCircleOutline" aria-hidden="true" />
        {{ t('doubts.ask.removePhoto') }}
      </ion-button>
    </div>
    <ion-button
      v-else
      :fill="compact ? 'clear' : 'outline'"
      :size="compact ? 'default' : undefined"
      @click="open"
    >
      <ion-icon :slot="compact ? 'icon-only' : 'start'" :icon="cameraOutline" aria-hidden="true" />
      <template v-if="!compact">{{ t('doubts.ask.addPhoto') }}</template>
      <span v-else class="sr-only">{{ t('doubts.ask.addPhoto') }}</span>
    </ion-button>
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { IonButton, IonIcon } from '@ionic/vue';
import { cameraOutline, closeCircleOutline } from 'ionicons/icons';

defineProps<{ compact?: boolean }>();
const model = defineModel<File | null>({ default: null });
const { t } = useI18n();
const input = ref<HTMLInputElement>();
const preview = ref<string | null>(null);

const open = () => input.value?.click();

function setPreview(file: File | null) {
  if (preview.value) URL.revokeObjectURL(preview.value);
  preview.value = file ? URL.createObjectURL(file) : null;
}

function pick(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0] ?? null;
  model.value = file;
  setPreview(file);
}

function clear() {
  model.value = null;
  setPreview(null);
  if (input.value) input.value.value = '';
}

defineExpose({ clear });
onBeforeUnmount(() => setPreview(null));
</script>

<style scoped>
.hidden-input {
  display: none;
}
.preview {
  display: flex;
  align-items: center;
  gap: 8px;
}
.preview img {
  max-height: 96px;
  max-width: 128px;
  border-radius: 8px;
  object-fit: cover;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}
</style>
