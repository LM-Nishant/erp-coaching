<template>
  <AppPage title="Offline lectures" back-href="/lms" :on-refresh="load">
    <p v-if="!supported" class="muted">
      Offline viewing is available in the mobile app only. Lectures are stored encrypted inside the app and
      cannot be exported.
    </p>
    <ion-list v-else>
      <ion-item
        v-for="i in items"
        :key="i.licenseId"
        :router-link="`/lms/resources/${i.resourceId}?offline=1`"
        detail
      >
        <ion-label>
          <h3>{{ i.title }}</h3>
          <p>{{ formatBytes(i.sizeBytes) }} · expires {{ fmtDateTime(i.expiresAt) }}</p>
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
      <ion-item v-if="!items.length">
        <ion-label class="muted"
          >No lectures saved. Use “Save offline” on a lecture that allows it.</ion-label
        >
      </ion-item>
    </ion-list>
  </AppPage>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { IonButton, IonIcon, IonItem, IonLabel, IonList, onIonViewWillEnter } from '@ionic/vue';
import { trashOutline } from 'ionicons/icons';
import AppPage from '@/components/AppPage.vue';
import { toastError } from '@/core/toast';
import { fmtDateTime, formatBytes } from './api';
import { listOffline, offlineSupported, removeOffline, syncOffline, type OfflineItem } from './offline-store';

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
