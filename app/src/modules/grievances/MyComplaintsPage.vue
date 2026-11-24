<template>
  <AppPage :title="t('grievances.mine.title')" :on-refresh="reload">
    <template #actions>
      <ion-button router-link="/grievances/new" :aria-label="t('grievances.newComplaint')"
        ><ion-icon slot="icon-only" :icon="add"
      /></ion-button>
    </template>

    <ion-segment v-model="tab">
      <ion-segment-button value="open"
        ><ion-label>{{ t('common.status.open') }}</ion-label></ion-segment-button
      >
      <ion-segment-button value="done"
        ><ion-label>{{ t('grievances.mine.done') }}</ion-label></ion-segment-button
      >
    </ion-segment>
    <ion-list>
      <TicketItem v-for="item in tickets" :key="item.id" :ticket="item" />
    </ion-list>
    <EmptyState
      v-if="!loading && !tickets.length"
      :icon="chatbubblesOutline"
      :title="t('grievances.mine.emptyTitle')"
      :message="t('grievances.mine.emptyMessage')"
    />
    <ion-infinite-scroll :disabled="tickets.length >= total" @ion-infinite="more">
      <ion-infinite-scroll-content />
    </ion-infinite-scroll>
  </AppPage>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  IonButton,
  IonIcon,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonLabel,
  IonList,
  IonSegment,
  IonSegmentButton,
  onIonViewWillEnter,
  type InfiniteScrollCustomEvent,
} from '@ionic/vue';
import { add, chatbubblesOutline } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import type { GrievanceTicketDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import EmptyState from '@/components/EmptyState.vue';
import { toastError } from '@/core/toast';
import { grievancesApi } from './api';
import TicketItem from './TicketItem.vue';

const { t } = useI18n();
const tab = ref<'open' | 'done'>('open');
const tickets = ref<GrievanceTicketDto[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(true);

async function load(reset = true) {
  loading.value = true;
  if (reset) page.value = 1;
  try {
    const res = await grievancesApi.mine({
      page: page.value,
      pageSize: 25,
      status: tab.value === 'open' ? 'open,in_progress,escalated' : 'resolved,closed',
    });
    tickets.value = reset ? res.items : [...tickets.value, ...res.items];
    total.value = res.total;
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}

const reload = () => load(true);

async function more(ev: InfiniteScrollCustomEvent) {
  page.value++;
  await load(false);
  await ev.target.complete();
}

onIonViewWillEnter(reload);
watch(tab, reload);
</script>
