<template>
  <AppPage title="Reports" :on-refresh="load">
    <template #actions>
      <ion-button v-can="'reports.export'" router-link="/reports/exports">
        <ion-icon slot="start" :icon="cloudDownloadOutline" />Exports
      </ion-button>
    </template>

    <p v-if="loaded && !catalog.length" class="muted">No reports are available for your role or plan.</p>
    <ion-list v-for="g in groups" :key="g.category">
      <ion-list-header>
        <ion-label>{{ g.label }}</ion-label>
      </ion-list-header>
      <ion-item v-for="r in g.items" :key="r.key" :router-link="`/reports/${r.key}`" detail>
        <ion-icon slot="start" :icon="g.icon" color="medium" />
        <ion-label>
          <h3>{{ r.title }}</h3>
          <p>{{ r.description }}</p>
        </ion-label>
      </ion-item>
    </ion-list>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { IonButton, IonIcon, IonItem, IonLabel, IonList, IonListHeader } from '@ionic/vue';
import {
  briefcaseOutline,
  cloudDownloadOutline,
  constructOutline,
  schoolOutline,
  walletOutline,
} from 'ionicons/icons';
import type { ReportCatalogItemDto, ReportCategory } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toastError } from '@/core/toast';
import { reportsApi } from './api';

const CATEGORIES: { category: ReportCategory; label: string; icon: string }[] = [
  { category: 'finance', label: 'Finance', icon: walletOutline },
  { category: 'academic', label: 'Academic', icon: schoolOutline },
  { category: 'staff', label: 'Staff', icon: briefcaseOutline },
  { category: 'operations', label: 'Operations', icon: constructOutline },
];

const catalog = ref<ReportCatalogItemDto[]>([]);
const loaded = ref(false);

const groups = computed(() =>
  CATEGORIES.map((c) => ({ ...c, items: catalog.value.filter((r) => r.category === c.category) })).filter(
    (g) => g.items.length,
  ),
);

async function load() {
  try {
    catalog.value = await reportsApi.catalog();
  } catch (e) {
    void toastError(e);
  } finally {
    loaded.value = true;
  }
}

onMounted(load);
</script>
