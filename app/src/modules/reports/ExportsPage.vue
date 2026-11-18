<template>
  <AppPage title="Report exports" back-href="/reports" :on-refresh="load">
    <p class="muted intro">
      Exports stay available for 24 hours. Large exports are prepared in the background and you are notified
      when they are ready.
    </p>
    <p v-if="loaded && !exports.length" class="muted">You have not exported any reports yet.</p>
    <ion-list v-if="exports.length">
      <ion-item v-for="e in exports" :key="e.id">
        <ion-label class="ion-text-wrap">
          <h3>
            {{ e.title }} <small class="muted">{{ FORMAT_LABELS[e.format] }}</small>
          </h3>
          <p>{{ e.periodLabel }} · {{ e.scopeLabel }}</p>
          <p>
            Requested {{ when(e.createdAt) }}
            <span v-if="e.rowCount !== null"> · {{ e.rowCount.toLocaleString('en-IN') }} rows</span>
            <span v-if="e.status === 'ready' && e.expiresAt"> · available until {{ when(e.expiresAt) }}</span>
          </p>
          <p v-if="e.status === 'failed' && e.error" class="error">{{ e.error }}</p>
        </ion-label>
        <ion-badge slot="end" :color="STATUS_COLORS[e.status]">{{ humanize(e.status) }}</ion-badge>
        <ion-button
          v-if="e.status === 'ready'"
          slot="end"
          fill="clear"
          :disabled="downloading === e.id"
          aria-label="Download"
          @click="download(e)"
          ><ion-icon slot="icon-only" :icon="downloadOutline"
        /></ion-button>
      </ion-item>
    </ion-list>
  </AppPage>
</template>

<script setup lang="ts">
import { onUnmounted, ref } from 'vue';
import {
  IonBadge,
  IonButton,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  onIonViewWillEnter,
  onIonViewWillLeave,
} from '@ionic/vue';
import { downloadOutline } from 'ionicons/icons';
import { DEFAULT_INSTITUTE_TIMEZONE, type ReportExportDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toastError } from '@/core/toast';
import { openExport, reportsApi } from './api';
import { FORMAT_LABELS, STATUS_COLORS } from './exportUi';
import { displayDateTime, humanize } from './format';

const POLL_MS = 5000;

const exports = ref<ReportExportDto[]>([]);
const loaded = ref(false);
const downloading = ref<number | null>(null);
const timezone = ref<string | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;
let active = false;

const when = (iso: string) => displayDateTime(iso, timezone.value ?? DEFAULT_INSTITUTE_TIMEZONE);

async function load() {
  stopPolling();
  try {
    if (!timezone.value) timezone.value = (await reportsApi.filterOptions()).timezone;
    exports.value = await reportsApi.exports();
  } catch (e) {
    void toastError(e);
  } finally {
    loaded.value = true;
  }
  // Keep pending exports fresh until they finish, while the page is shown.
  if (active && exports.value.some((e) => e.status === 'queued' || e.status === 'running')) {
    stopPolling();
    timer = setTimeout(() => void load(), POLL_MS);
  }
}

function stopPolling() {
  if (timer) clearTimeout(timer);
  timer = undefined;
}

async function download(e: ReportExportDto) {
  downloading.value = e.id;
  try {
    await openExport(e.id);
  } catch (err) {
    void toastError(err);
    void load();
  } finally {
    downloading.value = null;
  }
}

onIonViewWillEnter(() => {
  active = true;
  void load();
});
onIonViewWillLeave(() => {
  active = false;
  stopPolling();
});
onUnmounted(() => {
  active = false;
  stopPolling();
});
</script>

<style scoped>
.intro {
  margin-top: 0;
}
.error {
  color: var(--ion-color-danger);
}
ion-badge {
  text-transform: capitalize;
}
</style>
