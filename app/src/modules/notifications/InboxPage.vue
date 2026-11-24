<template>
  <AppPage :title="t('notifications.inbox.title')" :on-refresh="reload">
    <template #actions>
      <ion-button :disabled="!unread" @click="readAll">{{ t('notifications.inbox.markAllRead') }}</ion-button>
      <ion-button
        v-if="!auth.personalInbox"
        v-can="'notification-inbox.edit'"
        router-link="/notifications/preferences"
        :aria-label="t('notifications.inbox.preferences')"
      >
        <ion-icon slot="icon-only" :icon="settingsOutline" />
      </ion-button>
    </template>

    <ion-segment :value="filter" @ion-change="changeFilter(String($event.detail.value))">
      <ion-segment-button value="all"
        ><ion-label>{{ t('notifications.inbox.all') }}</ion-label></ion-segment-button
      >
      <ion-segment-button value="unread"
        ><ion-label>{{ t('notifications.inbox.unread') }}</ion-label></ion-segment-button
      >
    </ion-segment>

    <ion-list>
      <ion-item v-for="n in items" :key="n.id" button :detail="false" @click="open(n)">
        <ion-icon
          slot="start"
          :icon="n.readAt ? mailOpenOutline : mailUnreadOutline"
          :color="n.readAt ? 'medium' : 'primary'"
        />
        <ion-label :class="{ unread: !n.readAt }">
          <h2>{{ n.title ?? n.eventKey }}</h2>
          <p class="body">{{ n.body }}</p>
          <p class="muted">{{ formatDateTime(n.createdAt) }}</p>
        </ion-label>
      </ion-item>
      <ion-item v-if="!loading && !items.length"
        ><ion-label class="muted">{{ t('notifications.inbox.caughtUp') }}</ion-label></ion-item
      >
    </ion-list>
    <ion-infinite-scroll :disabled="items.length >= total" @ion-infinite="more">
      <ion-infinite-scroll-content />
    </ion-infinite-scroll>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
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
  type InfiniteScrollCustomEvent,
} from '@ionic/vue';
import { mailOpenOutline, mailUnreadOutline, settingsOutline } from 'ionicons/icons';
import { useI18n } from 'vue-i18n';
import type { InboxItemDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { formatDateTime } from '@/core/format';
import { toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { inboxApi } from './api';
import { unread } from './push';

const { t } = useI18n();
const auth = useAuthStore();
const items = ref<InboxItemDto[]>([]);
const total = ref(0);
const page = ref(1);
const loading = ref(true);
const filter = ref<'all' | 'unread'>('all');

async function load(reset: boolean) {
  if (reset) page.value = 1;
  loading.value = true;
  try {
    const res = await inboxApi.list({ page: page.value, unreadOnly: filter.value === 'unread' || undefined });
    items.value = reset ? res.items : [...items.value, ...res.items];
    total.value = res.total;
    unread.value = res.unread;
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

function changeFilter(v: string) {
  filter.value = v === 'unread' ? 'unread' : 'all';
  void reload();
}

async function open(n: InboxItemDto) {
  if (n.readAt) return;
  try {
    const updated = await inboxApi.markRead(n.id);
    n.readAt = updated.readAt;
    unread.value = Math.max(0, unread.value - 1);
  } catch (e) {
    await toastError(e);
  }
}

async function readAll() {
  try {
    await inboxApi.markAllRead();
    await reload();
  } catch (e) {
    await toastError(e);
  }
}

onMounted(reload);
</script>

<style scoped>
.unread h2 {
  font-weight: 600;
}
.body {
  white-space: normal;
}
</style>
