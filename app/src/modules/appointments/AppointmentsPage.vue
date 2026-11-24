<template>
  <AppPage :title="t('appointments.list.title')" :on-refresh="load">
    <template #actions>
      <ion-button v-if="auth.can('appointments.create')" router-link="/appointments/request">
        <ion-icon slot="start" :icon="addOutline" /> {{ t('appointments.list.request') }}
      </ion-button>
    </template>
    <ion-toolbar>
      <ion-segment v-model="tab" @ion-change="load">
        <ion-segment-button value="upcoming"
          ><ion-label>{{ t('common.status.upcoming') }}</ion-label></ion-segment-button
        >
        <ion-segment-button value="requested"
          ><ion-label>{{ t('common.status.pending') }}</ion-label></ion-segment-button
        >
        <ion-segment-button value="history"
          ><ion-label>{{ t('appointments.list.history') }}</ion-label></ion-segment-button
        >
      </ion-segment>
    </ion-toolbar>
    <ion-item v-if="canSeeAll" lines="none">
      <ion-toggle v-model="branchWide" @ion-change="load">{{ t('appointments.list.branchWide') }}</ion-toggle>
    </ion-item>
    <ion-list>
      <AppointmentItem v-for="a in items" :key="a.id" :appointment="a" />
    </ion-list>
    <EmptyState
      v-if="!loading && !items.length"
      :icon="calendarOutline"
      :title="t('appointments.list.empty')"
    />
    <ion-infinite-scroll :disabled="items.length >= total" @ion-infinite="more">
      <ion-infinite-scroll-content />
    </ion-infinite-scroll>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
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
  IonToggle,
  IonToolbar,
  onIonViewWillEnter,
  type InfiniteScrollCustomEvent,
} from '@ionic/vue';
import { addOutline, calendarOutline } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import type { AppointmentDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import EmptyState from '@/components/EmptyState.vue';
import { toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import AppointmentItem from './components/AppointmentItem.vue';
import { appointmentsApi, todayIso, type AppointmentFilters } from './api';

const { t } = useI18n();
const auth = useAuthStore();
const canSeeAll = computed(() => auth.can('appointments.export'));
const tab = ref<'upcoming' | 'requested' | 'history'>('upcoming');
const branchWide = ref(false);
const items = ref<AppointmentDto[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(true);

function filters(): AppointmentFilters {
  if (tab.value === 'upcoming') return { upcoming: true, status: 'confirmed', from: todayIso() };
  if (tab.value === 'requested') return { upcoming: true, status: 'requested' };
  return { to: todayIso() };
}

async function fetchPage(p: number) {
  const f = { ...filters(), page: p, pageSize: 20 };
  return branchWide.value ? appointmentsApi.all(f) : appointmentsApi.mine(f);
}

async function load() {
  loading.value = true;
  try {
    page.value = 1;
    const res = await fetchPage(1);
    items.value = res.items;
    total.value = res.total;
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}

async function more(ev: InfiniteScrollCustomEvent) {
  try {
    const res = await fetchPage(page.value + 1);
    page.value += 1;
    items.value.push(...res.items);
  } catch (e) {
    await toastError(e);
  } finally {
    await ev.target.complete();
  }
}

onIonViewWillEnter(load);
</script>
