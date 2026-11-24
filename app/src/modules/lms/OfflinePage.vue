<template>
  <AppPage :title="t('lms.offline.title')" back-href="/lms" :on-refresh="load">
    <EmptyState
      v-if="!supported"
      :icon="phonePortraitOutline"
      :title="t('lms.offline.appOnly')"
      :message="t('lms.offline.appOnlyHint')"
    >
      <ion-button router-link="/lms">{{ t('lms.offline.browse') }}</ion-button>
    </EmptyState>
    <ion-list v-else>
      <ion-item
        v-for="i in items"
        :key="i.licenseId"
        :router-link="`/lms/resources/${i.resourceId}?offline=1`"
        detail
      >
        <ion-label>
          <h3>{{ i.title }}</h3>
          <p>
            {{ t('lms.offline.meta', { size: formatBytes(i.sizeBytes), date: formatDateTime(i.expiresAt) }) }}
          </p>
        </ion-label>
        <ion-button
          slot="end"
          fill="clear"
          color="danger"
          :aria-label="`Delete ${i.title}`"
          @click.prevent.stop="remove(i)"
        >
          <ion-icon slot="icon-only" :icon="trashOutline" />
        </ion-button>
      </ion-item>
      <EmptyState
        v-if="!items.length"
        :icon="cloudDownloadOutline"
        :title="t('lms.offline.empty')"
        :message="t('lms.offline.emptyHint')"
      />
    </ion-list>
  </AppPage>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { IonButton, IonIcon, IonItem, IonLabel, IonList, onIonViewWillEnter } from '@ionic/vue';
import { cloudDownloadOutline, phonePortraitOutline, trashOutline } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import AppPage from '@/components/AppPage.vue';
import EmptyState from '@/components/EmptyState.vue';
import { formatDateTime } from '@/core/format';
import { toastError } from '@/core/toast';
import { formatBytes } from './api';
import { listOffline, offlineSupported, removeOffline, syncOffline, type OfflineItem } from './offline-store';

const { t } = useI18n();
const supported = offlineSupported();
const items = ref<OfflineItem[]>([]);

async function load() {
  if (!supported) return;
  // purge revoked copies when online; expired copies are purged locally either way
  await syncOffline().catch(() => undefined);
  items.value = await listOffline();
}

async function remove(i: OfflineItem) {
  try {
    await removeOffline(i);
    await load();
  } catch (e) {
    await toastError(e);
  }
}

onIonViewWillEnter(load);
</script>
