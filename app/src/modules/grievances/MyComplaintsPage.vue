<template>
  <AppPage title="My complaints" :on-refresh="reload">
    <template #actions>
      <ion-button router-link="/grievances/new"><ion-icon slot="icon-only" :icon="add" /></ion-button>
    </template>

    <ion-segment v-model="tab">
      <ion-segment-button value="open"><ion-label>Open</ion-label></ion-segment-button>
      <ion-segment-button value="done"><ion-label>Resolved / closed</ion-label></ion-segment-button>
    </ion-segment>
    <ion-list>
      <TicketItem v-for="t in tickets" :key="t.id" :ticket="t" />
      <ion-item v-if="!loading && !tickets.length">
        <ion-label class="muted">
          No complaints here. Tap <strong>+</strong> to raise a new complaint.
        </ion-label>
      </ion-item>
    </ion-list>
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
  IonItem,
  IonLabel,
  IonList,
  IonSegment,
  IonSegmentButton,
  onIonViewWillEnter,
  type InfiniteScrollCustomEvent,
} from '@ionic/vue';
import { add } from 'ionicons/icons';
import type { GrievanceTicketDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toastError } from '@/core/toast';
import { grievancesApi } from './api';
import TicketItem from './TicketItem.vue';

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
