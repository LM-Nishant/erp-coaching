<template>
  <div>
    <ion-list>
      <ion-item>
        <ion-select v-model="filter.status" label="Status" interface="popover" @ion-change="reload">
          <ion-select-option :value="undefined">Any</ion-select-option>
          <ion-select-option v-for="s in MESSAGE_STATUSES" :key="s" :value="s">{{ s }}</ion-select-option>
        </ion-select>
      </ion-item>
      <ion-item>
        <ion-select v-model="filter.channel" label="Channel" interface="popover" @ion-change="reload">
          <ion-select-option :value="undefined">Any</ion-select-option>
          <ion-select-option v-for="c in NOTIFICATION_CHANNELS" :key="c" :value="c">{{
            CHANNEL_LABELS[c]
          }}</ion-select-option>
        </ion-select>
      </ion-item>
    </ion-list>

    <ion-list>
      <ion-item v-for="m in items" :key="m.id" button :detail="false" @click="openDetail(m.id)">
        <ion-label>
          <h3>
            {{ m.recipientName ?? m.recipientAddress ?? '—' }}
            <ion-badge :color="STATUS_COLORS[m.status]">{{ m.status }}</ion-badge>
          </h3>
          <p>{{ CHANNEL_LABELS[m.channel] }} · {{ m.eventKey }} · {{ formatDate(m.createdAt) }}</p>
          <p>{{ m.body }}</p>
          <p v-if="m.lastError" class="error">{{ m.lastError }}</p>
        </ion-label>
        <ion-button
          v-if="m.status === 'failed'"
          slot="end"
          v-can="'notifications.create'"
          fill="clear"
          @click.stop="retry(m.id)"
          >Retry</ion-button
        >
      </ion-item>
      <ion-item v-if="!loading && !items.length"><ion-label class="muted">No messages.</ion-label></ion-item>
    </ion-list>
    <ion-infinite-scroll :disabled="items.length >= total" @ion-infinite="more">
      <ion-infinite-scroll-content />
    </ion-infinite-scroll>

    <ion-modal :is-open="!!detail" @did-dismiss="detail = null">
      <ion-header>
        <ion-toolbar>
          <ion-title>Message #{{ detail?.id }}</ion-title>
          <ion-buttons slot="end"><ion-button @click="detail = null">Close</ion-button></ion-buttons>
        </ion-toolbar>
      </ion-header>
      <ion-content v-if="detail" class="ion-padding">
        <p>
          <ion-badge :color="STATUS_COLORS[detail.status]">{{ detail.status }}</ion-badge>
          {{ CHANNEL_LABELS[detail.channel] }} to {{ detail.recipientName }} ({{
            detail.recipientAddress ?? 'inbox'
          }})
        </p>
        <p v-if="detail.subject">
          <strong>{{ detail.subject }}</strong>
        </p>
        <p class="body">{{ detail.body }}</p>
        <p class="muted">
          Attempts {{ detail.attempts }}/{{ detail.maxAttempts }} · Provider {{ detail.provider ?? '—' }}
          <span v-if="detail.nextAttemptAt"> · Next try {{ formatDate(detail.nextAttemptAt) }}</span>
        </p>
        <ion-list>
          <ion-list-header><ion-label>Delivery attempts</ion-label></ion-list-header>
          <ion-item v-for="a in detail.deliveryAttempts" :key="a.id">
            <ion-label>
              <h3>
                #{{ a.attemptNo }} <ion-badge :color="STATUS_COLORS[a.status]">{{ a.status }}</ion-badge>
              </h3>
              <p>{{ a.provider }} · {{ formatDate(a.createdAt) }} · {{ a.durationMs ?? '—' }} ms</p>
              <p v-if="a.error" class="error">{{ a.error }}</p>
            </ion-label>
          </ion-item>
          <ion-item v-if="!detail.deliveryAttempts.length"
            ><ion-label class="muted">None</ion-label></ion-item
          >
        </ion-list>
      </ion-content>
    </ion-modal>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import {
  IonBadge,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonInfiniteScroll,
  IonInfiniteScrollContent,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
  IonModal,
  IonSelect,
  IonSelectOption,
  IonTitle,
  IonToolbar,
  type InfiniteScrollCustomEvent,
} from '@ionic/vue';
import {
  MESSAGE_STATUSES,
  NOTIFICATION_CHANNELS,
  type DeliveryAttemptDto,
  type NotificationMessageDto,
} from '@erp/shared';
import { toast, toastError } from '@/core/toast';
import { CHANNEL_LABELS, STATUS_COLORS, commsApi, formatDate, type HistoryFilter } from '../api';

const items = ref<NotificationMessageDto[]>([]);
const total = ref(0);
const loading = ref(true);
const filter = reactive<HistoryFilter>({ page: 1 });
const detail = ref<(NotificationMessageDto & { deliveryAttempts: DeliveryAttemptDto[] }) | null>(null);

async function load(reset: boolean) {
  if (reset) filter.page = 1;
  loading.value = true;
  try {
    const res = await commsApi.messages(filter);
    items.value = reset ? res.items : [...items.value, ...res.items];
    total.value = res.total;
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}
const reload = () => load(true);

async function more(ev: InfiniteScrollCustomEvent) {
  filter.page = (filter.page ?? 1) + 1;
  await load(false);
  await ev.target.complete();
}

async function openDetail(id: number) {
  try {
    detail.value = await commsApi.message(id);
  } catch (e) {
    await toastError(e);
  }
}

async function retry(id: number) {
  try {
    await commsApi.retry(id);
    await toast('Message re-queued');
    await reload();
  } catch (e) {
    await toastError(e);
  }
}

onMounted(reload);
</script>

<style scoped>
.error {
  color: var(--ion-color-danger);
}
.body {
  white-space: pre-wrap;
}
</style>
