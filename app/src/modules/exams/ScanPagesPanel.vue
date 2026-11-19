<template>
  <div class="scan">
    <div class="scan-head">
      <strong>Handwritten pages</strong>
      <ion-note>{{ pages.length }} page{{ pages.length === 1 ? '' : 's' }}</ion-note>
    </div>
    <p class="muted hint">
      Write your answer on paper, then scan or upload each page in order. You can reorder or remove pages
      until you submit.
    </p>
    <div class="scan-actions">
      <ion-button size="small" :disabled="disabled || busy" @click="scan">
        <ion-icon slot="start" :icon="cameraOutline" />Scan page
      </ion-button>
      <ion-button size="small" fill="outline" :disabled="disabled || busy" @click="pickFiles?.click()">
        <ion-icon slot="start" :icon="cloudUploadOutline" />Upload files
      </ion-button>
      <ion-spinner v-if="busy" name="dots" />
      <span v-if="progress" class="muted">{{ progress }}</span>
    </div>
    <input
      ref="cameraInput"
      class="hidden-input"
      type="file"
      accept="image/*,application/pdf"
      capture="environment"
      multiple
      @change="onFiles"
    />
    <input
      ref="pickFiles"
      class="hidden-input"
      type="file"
      accept="image/*,application/pdf"
      multiple
      @change="onFiles"
    />

    <div v-if="pages.length" class="thumbs">
      <div v-for="(p, i) in pages" :key="p.id" class="thumb">
        <a
          :href="p.url"
          target="_blank"
          rel="noopener"
          class="thumb-img"
          :aria-label="`Open page ${p.pageNo}`"
        >
          <img v-if="!broken[p.id]" :src="p.url" :alt="`Page ${p.pageNo}`" @error="broken[p.id] = true" />
          <ion-icon v-else :icon="documentOutline" class="doc-icon" />
        </a>
        <div class="thumb-bar">
          <span class="page-no">Page {{ p.pageNo }}</span>
          <ion-button
            fill="clear"
            size="small"
            :disabled="disabled || busy || i === 0"
            aria-label="Move up"
            @click="move(i, -1)"
            ><ion-icon slot="icon-only" :icon="arrowUpOutline"
          /></ion-button>
          <ion-button
            fill="clear"
            size="small"
            :disabled="disabled || busy || i === pages.length - 1"
            aria-label="Move down"
            @click="move(i, 1)"
            ><ion-icon slot="icon-only" :icon="arrowDownOutline"
          /></ion-button>
          <ion-button
            fill="clear"
            size="small"
            color="danger"
            :disabled="disabled || busy"
            aria-label="Delete page"
            @click="remove(p)"
            ><ion-icon slot="icon-only" :icon="trashOutline"
          /></ion-button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import { IonButton, IonIcon, IonNote, IonSpinner, alertController, modalController } from '@ionic/vue';
import {
  arrowDownOutline,
  arrowUpOutline,
  cameraOutline,
  cloudUploadOutline,
  documentOutline,
  trashOutline,
} from 'ionicons/icons';
import { Capacitor } from '@capacitor/core';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import type { AnswerPageDto } from '@erp/shared';
import { ApiError } from '@/core/api';
import { toastError } from '@/core/toast';
import { examsApi } from './api';
import ScanPagesCropModal from './ScanPagesCropModal.vue';

const props = defineProps<{
  attemptId: number;
  examQuestionId: number;
  pages: AnswerPageDto[];
  disabled?: boolean;
}>();
const emit = defineEmits<{
  'update:pages': [pages: AnswerPageDto[]];
  /** The attempt was closed server-side (deadline passed / already submitted). */
  closed: [error: ApiError];
}>();

const cameraInput = ref<HTMLInputElement | null>(null);
const pickFiles = ref<HTMLInputElement | null>(null);
const busy = ref(false);
const progress = ref('');
const broken = reactive<Record<number, boolean>>({});

const isClosed = (e: unknown): e is ApiError =>
  e instanceof ApiError && e.status === 409 && e.code === 'ATTEMPT_CLOSED';

async function handleError(e: unknown) {
  if (isClosed(e)) emit('closed', e);
  else await toastError(e);
}

async function scan() {
  if (!Capacitor.isNativePlatform()) {
    cameraInput.value?.click();
    return;
  }
  try {
    const photo = await Camera.getPhoto({
      resultType: CameraResultType.Uri,
      source: CameraSource.Prompt,
      quality: 80,
      // Native crop / rotate UI.
      allowEditing: true,
      correctOrientation: true,
    });
    if (!photo.webPath) return;
    const blob = await (await fetch(photo.webPath)).blob();
    await upload([{ blob, name: `page.${photo.format || 'jpg'}` }]);
  } catch (e) {
    const msg = (e as Error)?.message ?? '';
    if (/cancel/i.test(msg)) return;
    await toastError(e);
  }
}

/** Web crop step; returns `null` when the student cancels. */
async function cropOnWeb(file: File): Promise<Blob | null> {
  const modal = await modalController.create({ component: ScanPagesCropModal, componentProps: { file } });
  await modal.present();
  const { data, role } = await modal.onDidDismiss<Blob | null>();
  return role === 'confirm' && data ? data : null;
}

async function onFiles(ev: Event) {
  const input = ev.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = '';
  if (!files.length) return;
  const ready: { blob: Blob; name: string }[] = [];
  for (const f of files) {
    if (f.type === 'application/pdf') {
      ready.push({ blob: f, name: f.name });
      continue;
    }
    if (!f.type.startsWith('image/')) {
      await toastError(new Error(`${f.name} is not an image or PDF`));
      continue;
    }
    const cropped = await cropOnWeb(f);
    if (cropped) ready.push({ blob: cropped, name: f.name.replace(/\.[^.]+$/, '') + '.jpg' });
  }
  await upload(ready);
}

async function upload(items: { blob: Blob; name: string }[]) {
  if (!items.length) return;
  busy.value = true;
  try {
    for (const [i, it] of items.entries()) {
      progress.value = items.length > 1 ? `Uploading ${i + 1} of ${items.length}…` : 'Uploading…';
      emit(
        'update:pages',
        await examsApi.uploadPage(props.attemptId, props.examQuestionId, it.blob, it.name),
      );
    }
  } catch (e) {
    await handleError(e);
  } finally {
    busy.value = false;
    progress.value = '';
  }
}

async function move(i: number, dir: -1 | 1) {
  const ids = props.pages.map((p) => p.id);
  [ids[i], ids[i + dir]] = [ids[i + dir], ids[i]];
  busy.value = true;
  try {
    emit('update:pages', await examsApi.reorderPages(props.attemptId, props.examQuestionId, ids));
  } catch (e) {
    await handleError(e);
  } finally {
    busy.value = false;
  }
}

async function remove(p: AnswerPageDto) {
  const alert = await alertController.create({
    header: `Delete page ${p.pageNo}?`,
    buttons: [
      { text: 'Cancel', role: 'cancel' },
      { text: 'Delete', role: 'destructive' },
    ],
  });
  await alert.present();
  if ((await alert.onDidDismiss()).role !== 'destructive') return;
  busy.value = true;
  try {
    emit('update:pages', await examsApi.removePage(props.attemptId, props.examQuestionId, p.id));
  } catch (e) {
    await handleError(e);
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.scan {
  margin-top: 16px;
  padding: 12px;
  border: 1px dashed var(--ion-color-medium);
  border-radius: 8px;
}
.scan-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.hint {
  font-size: 0.85rem;
  margin: 4px 0 8px;
}
.scan-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.hidden-input {
  display: none;
}
.thumbs {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 10px;
  margin-top: 12px;
}
.thumb {
  border: 1px solid var(--ion-color-light-shade);
  border-radius: 6px;
  overflow: hidden;
}
.thumb-img {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 160px;
  background: var(--ion-color-light);
}
.thumb-img img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
.doc-icon {
  font-size: 48px;
  color: var(--ion-color-medium);
}
.thumb-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.page-no {
  font-size: 0.8rem;
  font-weight: 600;
  padding-left: 6px;
}
</style>
