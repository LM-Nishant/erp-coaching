<template>
  <ion-page>
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-back-button v-if="backHref" :default-href="backHref" />
          <ion-menu-button v-else />
        </ion-buttons>
        <ion-title>{{ title }}</ion-title>
        <ion-buttons slot="end"
          ><slot name="actions" /><component :is="item" v-for="(item, i) in toolbarItems" :key="i"
        /></ion-buttons>
      </ion-toolbar>
    </ion-header>
    <ion-content :class="{ 'ion-padding': padded }">
      <ion-refresher v-if="onRefresh" slot="fixed" @ion-refresh="refresh"
        ><ion-refresher-content
      /></ion-refresher>
      <div class="page-container">
        <div v-if="loading" class="page-skeleton" role="status" :aria-label="t('shell.loading')">
          <ion-skeleton-text v-for="i in 4" :key="i" animated class="row" />
        </div>
        <slot v-else />
      </div>
    </ion-content>
  </ion-page>
</template>

<script setup lang="ts">
import {
  IonBackButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonMenuButton,
  IonPage,
  IonRefresher,
  IonRefresherContent,
  IonSkeletonText,
  IonTitle,
  IonToolbar,
  type RefresherCustomEvent,
} from '@ionic/vue';
import { useI18n } from 'vue-i18n';
import { toolbarItems } from '@/core/modules';

const props = withDefaults(
  defineProps<{
    title: string;
    backHref?: string;
    padded?: boolean;
    onRefresh?: () => Promise<unknown>;
    /** First load in progress: show placeholder rows instead of the page body. */
    loading?: boolean;
  }>(),
  {
    padded: true,
    loading: false,
    backHref: undefined,
    onRefresh: undefined,
  },
);

const { t } = useI18n();

async function refresh(ev: RefresherCustomEvent) {
  try {
    await props.onRefresh?.();
  } finally {
    await ev.target.complete();
  }
}
</script>

<style scoped>
.page-skeleton .row {
  height: 64px;
  margin: 0 0 12px;
  border-radius: 12px;
}
</style>
