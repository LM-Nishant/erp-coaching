<template>
  <AppPage title="Audit log" :on-refresh="() => load(true)">
    <ion-searchbar
      v-model="action"
      :debounce="400"
      placeholder="Filter by action, e.g. institute."
      @ion-input="load(true)"
    />
    <ion-list>
      <ion-item v-for="e in rows" :key="e.id">
        <ion-label class="ion-text-wrap">
          <h3>{{ e.action }}</h3>
          <p>
            {{ new Date(e.createdAt).toLocaleString() }} · actor #{{ e.actorUserId ?? '—' }}
            <span v-if="e.impersonatorUserId"> (impersonated by #{{ e.impersonatorUserId }})</span>
            · institute #{{ e.instituteId ?? '—' }} · {{ e.entityType }} {{ e.entityId }} · {{ e.ip }}
          </p>
          <p v-if="e.metadata">
            <code>{{ JSON.stringify(e.metadata) }}</code>
          </p>
        </ion-label>
      </ion-item>
    </ion-list>
    <ion-infinite-scroll :disabled="rows.length >= total" @ion-infinite="more">
      <ion-infinite-scroll-content />
    </ion-infinite-scroll>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import {
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonItem,
  IonLabel,
  IonList,
  IonSearchbar,
  type InfiniteScrollCustomEvent,
} from '@ionic/vue';
import AppPage from '@/components/AppPage.vue';
import { toastError } from '@/core/toast';
import { adminApi, type AuditEventRow } from './api';

const rows = ref<AuditEventRow[]>([]);
const total = ref(0);
const page = ref(1);
const action = ref('');

async function load(reset = false) {
  if (reset) page.value = 1;
  try {
    const res = await adminApi.audit({ page: page.value, action: action.value || undefined });
    rows.value = reset ? res.items : [...rows.value, ...res.items];
    total.value = res.total;
  } catch (e) {
    await toastError(e);
  }
}

async function more(ev: InfiniteScrollCustomEvent) {
  page.value += 1;
  await load();
  await ev.target.complete();
}

onMounted(() => load(true));
</script>
