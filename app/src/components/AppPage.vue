<template>
  <ion-page>
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start">
          <ion-back-button v-if="backHref" :default-href="backHref" />
          <ion-menu-button v-else />
        </ion-buttons>
        <ion-title>{{ title }}</ion-title>
        <ion-buttons slot="end"><slot name="actions" /></ion-buttons>
      </ion-toolbar>
    </ion-header>
    <ion-content :class="{ 'ion-padding': padded }">
      <ion-refresher v-if="onRefresh" slot="fixed" @ion-refresh="refresh"
        ><ion-refresher-content
      /></ion-refresher>
      <div class="page-container"><slot /></div>
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
  IonTitle,
  IonToolbar,
  type RefresherCustomEvent,
} from '@ionic/vue';

const props = withDefaults(
  defineProps<{ title: string; backHref?: string; padded?: boolean; onRefresh?: () => Promise<unknown> }>(),
  {
    padded: true,
    backHref: undefined,
    onRefresh: undefined,
  },
);

async function refresh(ev: RefresherCustomEvent) {
  try {
    await props.onRefresh?.();
  } finally {
    await ev.target.complete();
  }
}
</script>
