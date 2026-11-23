<template>
  <AppPage :title="t('doubts.mine.title')" :on-refresh="reload">
    <ion-segment v-model="status">
      <ion-segment-button value="open"
        ><ion-label>{{ t('doubts.mine.waiting') }}</ion-label></ion-segment-button
      >
      <ion-segment-button value="answered"
        ><ion-label>{{ t('doubts.mine.answered') }}</ion-label></ion-segment-button
      >
      <ion-segment-button value="resolved"
        ><ion-label>{{ t('doubts.mine.solved') }}</ion-label></ion-segment-button
      >
    </ion-segment>
    <ion-list v-if="items.length">
      <DoubtItem v-for="d in items" :key="d.id" :doubt="d" />
    </ion-list>
    <EmptyState
      v-else-if="!loading"
      :icon="helpCircleOutline"
      :title="t('doubts.mine.emptyTitle')"
      :message="t('doubts.mine.emptyMessage')"
    >
      <ion-button router-link="/doubts/ask">{{ t('doubts.ask.button') }}</ion-button>
    </EmptyState>
    <ion-infinite-scroll :disabled="items.length >= total" @ion-infinite="more">
      <ion-infinite-scroll-content />
    </ion-infinite-scroll>

    <ion-fab slot="fixed" vertical="bottom" horizontal="end">
      <ion-fab-button router-link="/doubts/ask" :aria-label="t('doubts.ask.button')" data-testid="ask-doubt">
        <ion-icon :icon="add" aria-hidden="true" />
      </ion-fab-button>
    </ion-fab>
  </AppPage>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  IonButton,
  IonFab,
  IonFabButton,
  IonIcon,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonLabel,
  IonList,
  IonSegment,
  IonSegmentButton,
  onIonViewWillEnter,
} from '@ionic/vue';
import { add, helpCircleOutline } from 'ionicons/icons';
import type { DoubtStatus } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import EmptyState from '@/components/EmptyState.vue';
import DoubtItem from './DoubtItem.vue';
import { useDoubtList } from './useDoubtList';

const { t } = useI18n();
const status = ref<DoubtStatus>('open');
const { items, total, loading, reload, more } = useDoubtList(() => ({ box: 'mine', status: status.value }));

onIonViewWillEnter(reload);
watch(status, reload);
</script>

<style scoped>
ion-segment-button {
  min-width: 0;
  text-transform: none;
  font-size: 15px;
  min-height: var(--app-tap-target, 48px);
}
</style>
