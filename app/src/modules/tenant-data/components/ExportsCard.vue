<template>
  <ion-card>
    <ion-card-header>
      <ion-card-title>Data export</ion-card-title>
      <ion-card-subtitle
        >Every record of the institute as JSON and CSV files in one zip, optionally with uploaded
        files.</ion-card-subtitle
      >
    </ion-card-header>
    <ion-card-content>
      <div v-if="canExport" class="request">
        <ion-toggle v-model="includeMedia" label-placement="end"
          >Include uploaded files (documents, photos, media)</ion-toggle
        >
        <ion-button :disabled="busy || rows.some(exportInProgress)" @click="start">Prepare export</ion-button>
      </div>
      <p class="muted note">
        The archive is prepared in the background and kept for 7 days (at most 3 at a time). Download links
        are valid for 10 minutes.
      </p>
      <ion-list v-if="rows.length" lines="full">
        <ion-item v-for="x in rows" :key="x.id">
          <ion-label class="ion-text-wrap">
            <h3>
              {{ formatWhen(x.createdAt) }}
              <span class="muted">· {{ x.requestedByName ?? 'Platform team' }}</span>
            </h3>
            <p>{{ exportDetail(x) }}</p>
            <p v-if="x.error" class="error">{{ x.error }}</p>
          </ion-label>
          <div slot="end" class="end">
            <ion-spinner v-if="exportInProgress(x)" name="dots" />
            <ion-badge :color="EXPORT_STATUS_COLORS[x.status]">{{
              EXPORT_STATUS_LABELS[x.status]
            }}</ion-badge>
            <ion-button
              v-if="canExport && x.status === 'ready'"
              size="small"
              :disabled="busy"
              @click="download(x)"
            >
              <ion-icon slot="start" :icon="downloadOutline" />Download
            </ion-button>
            <ion-button
              v-if="canExport && !exportInProgress(x)"
              size="small"
              fill="clear"
              color="danger"
              :disabled="busy"
              aria-label="Delete export"
              @click="remove(x)"
            >
              <ion-icon slot="icon-only" :icon="trashOutline" />
            </ion-button>
          </div>
        </ion-item>
      </ion-list>
      <p v-else-if="loaded" class="muted">No exports yet.</p>
    </ion-card-content>
  </ion-card>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import {
  IonBadge,
  IonButton,
  IonCard,
  IonCardContent,
  IonCardHeader,
  IonCardSubtitle,
  IonCardTitle,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonSpinner,
  IonToggle,
  alertController,
} from '@ionic/vue';
import { downloadOutline, trashOutline } from 'ionicons/icons';
import type { DataExportDto } from '@erp/shared';
import { openFileLink } from '@/core/downloads';
import { toast, toastError } from '@/core/toast';
import {
  EXPORT_STATUS_COLORS,
  EXPORT_STATUS_LABELS,
  exportDetail,
  exportInProgress,
  formatWhen,
  type TenantDataScope,
} from '../api';

const props = defineProps<{ scope: TenantDataScope; canExport: boolean }>();

const POLL_MS = 4000;
const rows = ref<DataExportDto[]>([]);
const loaded = ref(false);
const busy = ref(false);
const includeMedia = ref(true);
let timer: ReturnType<typeof setTimeout> | undefined;
let unmounted = false;

/** Polls while an export is being prepared. */
function schedule() {
  clearTimeout(timer);
  if (!unmounted && rows.value.some(exportInProgress)) timer = setTimeout(() => void load(true), POLL_MS);
}

async function load(quiet = false) {
  try {
    rows.value = await props.scope.exports();
    loaded.value = true;
  } catch (e) {
    if (!quiet) await toastError(e);
  } finally {
    schedule();
  }
}

async function start() {
  busy.value = true;
  try {
    const x = await props.scope.requestExport(includeMedia.value);
    rows.value = [x, ...rows.value.filter((r) => r.id !== x.id)];
    await toast('Export queued. It appears here when ready.');
    schedule();
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

async function download(x: DataExportDto) {
  busy.value = true;
  try {
    openFileLink((await props.scope.exportLink(x.id)).url);
  } catch (e) {
    await toastError(e);
    await load(true);
  } finally {
    busy.value = false;
  }
}

async function remove(x: DataExportDto) {
  const alert = await alertController.create({
    header: 'Delete this export?',
    message: 'The archive is removed from the server. You can prepare a new export at any time.',
    buttons: [
      { text: 'Keep', role: 'cancel' },
      { text: 'Delete', role: 'destructive' },
    ],
  });
  await alert.present();
  if ((await alert.onDidDismiss()).role !== 'destructive') return;
  try {
    await props.scope.deleteExport(x.id);
    rows.value = rows.value.filter((r) => r.id !== x.id);
  } catch (e) {
    await toastError(e);
  }
}

onMounted(() => void load());
onBeforeUnmount(() => {
  unmounted = true;
  clearTimeout(timer);
});

defineExpose({ load });
</script>

<style scoped>
.request {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
}
.note {
  font-size: 13px;
}
.end {
  display: flex;
  align-items: center;
  gap: 6px;
}
.error {
  color: var(--ion-color-danger);
}
</style>
