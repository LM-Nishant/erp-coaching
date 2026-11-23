<template>
  <AppPage :title="t('doubts.inbox.title')" :on-refresh="reload">
    <ion-segment v-model="status">
      <ion-segment-button value="open"
        ><ion-label>{{ t('doubts.inbox.toAnswer') }}</ion-label></ion-segment-button
      >
      <ion-segment-button value="answered"
        ><ion-label>{{ t('doubts.inbox.answered') }}</ion-label></ion-segment-button
      >
      <ion-segment-button value="resolved"
        ><ion-label>{{ t('doubts.inbox.solved') }}</ion-label></ion-segment-button
      >
    </ion-segment>
    <ion-item v-if="canSeeAll" lines="none">
      <ion-toggle v-model="all" justify="space-between">{{ t('doubts.inbox.allBranches') }}</ion-toggle>
    </ion-item>
    <ion-list v-if="items.length">
      <DoubtItem v-for="d in items" :key="d.id" :doubt="d" show-student />
    </ion-list>
    <EmptyState
      v-else-if="!loading"
      :icon="chatbubblesOutline"
      :title="t('doubts.inbox.emptyTitle')"
      :message="t('doubts.inbox.emptyMessage')"
    />
    <ion-infinite-scroll :disabled="items.length >= total" @ion-infinite="more">
      <ion-infinite-scroll-content />
    </ion-infinite-scroll>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonItem,
  IonLabel,
  IonList,
  IonSegment,
  IonSegmentButton,
  IonToggle,
  onIonViewWillEnter,
} from '@ionic/vue';
import { chatbubblesOutline } from 'ionicons/icons';
import type { DoubtStatus } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import EmptyState from '@/components/EmptyState.vue';
import { useAuthStore } from '@/stores/auth';
import DoubtItem from './DoubtItem.vue';
import { useDoubtList } from './useDoubtList';

const { t } = useI18n();
const auth = useAuthStore();
const canSeeAll = computed(() => auth.can('doubts.export'));
const status = ref<DoubtStatus>('open');
const all = ref(false);
const { items, total, loading, reload, more } = useDoubtList(() => ({
  box: all.value && canSeeAll.value ? 'all' : 'inbox',
  status: status.value,
}));

onIonViewWillEnter(reload);
watch([status, all], reload);
</script>

<style scoped>
ion-segment-button {
  min-width: 0;
  text-transform: none;
  font-size: 15px;
  min-height: var(--app-tap-target, 48px);
}
</style>
