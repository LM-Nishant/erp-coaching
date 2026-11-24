<template>
  <AppPage :title="t('reports.exports.title')" back-href="/reports" :on-refresh="load">
    <p class="muted intro">{{ t('reports.exports.intro') }}</p>
    <p v-if="loaded && !exports.length" class="muted">{{ t('reports.exports.empty') }}</p>
    <ion-list v-if="exports.length">
      <ion-item v-for="e in exports" :key="e.id">
        <ion-label class="ion-text-wrap">
          <h3>
            {{ e.title }} <small class="muted">{{ formatLabel(e.format) }}</small>
          </h3>
          <p>{{ e.periodLabel }} · {{ e.scopeLabel }}</p>
          <p>
            {{ t('reports.exports.requested', { when: when(e.createdAt) }) }}
            <span v-if="e.rowCount !== null">
              · {{ t('reports.exports.rows', { n: formatNumber(e.rowCount) }, e.rowCount) }}</span
            >
            <span v-if="e.status === 'ready' && e.expiresAt">
              · {{ t('reports.exports.availableUntil', { when: when(e.expiresAt) }) }}</span
            >
          </p>
          <p v-if="e.status === 'failed' && e.error" class="error">{{ e.error }}</p>
        </ion-label>
        <StatusChip
          slot="end"
          :label="t(`reports.exports.status.${e.status}`)"
          :tone="STATUS_TONES[e.status]"
        />
        <ion-button
          v-if="e.status === 'ready'"
          slot="end"
          fill="clear"
          :disabled="downloading === e.id"
          :aria-label="t('common.actions.download')"
          @click="download(e)"
          ><ion-icon slot="icon-only" :icon="downloadOutline"
        /></ion-button>
      </ion-item>
    </ion-list>
  </AppPage>
</template>

<script setup lang="ts">
import { onUnmounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
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
import StatusChip from '@/components/StatusChip.vue';
import { formatNumber } from '@/core/format';
import { toast, toastError } from '@/core/toast';
import { reportsApi, saveExport } from './api';
import { formatLabel, STATUS_TONES } from './exportUi';
import { displayDateTime } from './format';

const POLL_MS = 5000;
const { t } = useI18n();

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
    const saved = await saveExport(e);
    if (saved) await toast(saved);
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
</style>
