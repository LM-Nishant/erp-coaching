<template>
  <div class="media-upload">
    <div v-if="media" class="current">
      <img v-if="media.kind === 'image' && media.url" :src="media.url" alt="" />
      <div>
        <strong>{{ media.originalName }}</strong>
        <div class="muted">
          {{ (media.sizeBytes / 1024 / 1024).toFixed(1) }} MB ·
          <span :class="media.status">{{ STATUS[media.status] }}</span>
          <template v-if="media.durationSeconds"> · {{ clock(media.durationSeconds) }}</template>
        </div>
        <div v-if="media.error" class="failed">{{ media.error }}</div>
      </div>
    </div>
    <ion-progress-bar v-if="share !== null" :value="share" />
    <ion-button size="small" fill="outline" :disabled="share !== null" @click="input?.click()">
      {{ media ? 'Replace' : label }}
    </ion-button>
    <input ref="input" type="file" :accept="accept" hidden :data-testid="testid" @change="pick" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { IonButton, IonProgressBar } from '@ionic/vue';
import type { MktMediaDto, MktMediaKind } from '@erp/shared';
import { toastError } from '@/core/toast';
import { clock, studioApi, videoDuration, type StudioScope } from '../api';

const STATUS: Record<string, string> = {
  uploading: 'Uploading',
  processing: 'Processing',
  ready: 'Ready',
  failed: 'Failed',
};
const props = defineProps<{
  scope: StudioScope;
  kind: MktMediaKind;
  media: MktMediaDto | null;
  label: string;
  testid?: string;
}>();
const emit = defineEmits<{ uploaded: [MktMediaDto] }>();
const input = ref<HTMLInputElement | null>(null);
const share = ref<number | null>(null);
const accept = computed(() =>
  props.kind === 'image'
    ? 'image/png,image/jpeg,image/webp,image/gif'
    : props.kind === 'video'
      ? 'video/*'
      : '',
);

async function pick(ev: Event) {
  const file = (ev.target as HTMLInputElement).files?.[0];
  (ev.target as HTMLInputElement).value = '';
  if (!file) return;
  share.value = 0;
  try {
    const duration = props.kind === 'video' ? await videoDuration(file) : undefined;
    const m = await studioApi(props.scope).upload(file, props.kind, (s) => (share.value = s), duration);
    emit('uploaded', m);
  } catch (e) {
    void toastError(e);
  } finally {
    share.value = null;
  }
}
</script>

<style scoped>
.media-upload {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-start;
  width: 100%;
}
.current {
  display: flex;
  gap: 10px;
  align-items: center;
}
.current img {
  width: 120px;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  border-radius: 6px;
}
.muted {
  color: var(--ion-color-medium);
  font-size: 12px;
}
.ready {
  color: var(--ion-color-success-shade);
}
.processing,
.uploading {
  color: var(--ion-color-warning-shade);
}
.failed {
  color: var(--ion-color-danger);
}
</style>
