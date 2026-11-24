<template>
  <AppPage :title="t('admin.audit.title')" :on-refresh="() => load(true)">
    <ion-searchbar
      v-model="action"
      :debounce="400"
      :placeholder="t('admin.audit.filterPlaceholder')"
      @ion-input="load(true)"
    />
    <ion-list>
      <ion-item v-for="e in rows" :key="e.id">
        <ion-label class="ion-text-wrap">
          <h3>{{ e.action }}</h3>
          <p>
            {{ formatDateTime(e.createdAt) }} · {{ t('admin.audit.actor', { id: e.actorUserId ?? '—' }) }}
            <span v-if="e.impersonatorUserId">
              {{ t('admin.audit.impersonatedBy', { id: e.impersonatorUserId }) }}</span
            >
            · {{ t('admin.audit.institute', { id: e.instituteId ?? '—' }) }} · {{ e.entityType }}
            {{ e.entityId }} · {{ e.ip }}
          </p>
          <p v-if="e.metadata">
            <code>{{ JSON.stringify(e.metadata) }}</code>
          </p>
        </ion-label>
      </ion-item>
    </ion-list>
    <p v-if="loaded && !rows.length" class="muted">{{ t('admin.audit.empty') }}</p>
    <ion-infinite-scroll :disabled="rows.length >= total" @ion-infinite="more">
      <ion-infinite-scroll-content />
    </ion-infinite-scroll>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
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
import { formatDateTime } from '@/core/format';
import { toastError } from '@/core/toast';
import { adminApi, type AuditEventRow } from './api';

const { t } = useI18n();
const loaded = ref(false);
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
  } finally {
    loaded.value = true;
  }
}

async function more(ev: InfiniteScrollCustomEvent) {
  page.value += 1;
  await load();
  await ev.target.complete();
}

onMounted(() => load(true));
</script>
