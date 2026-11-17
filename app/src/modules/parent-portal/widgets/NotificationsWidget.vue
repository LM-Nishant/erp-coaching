<template>
  <ion-list lines="none">
    <ion-item v-for="n in items" :key="n.id" button :detail="false" router-link="/notifications">
      <ion-icon slot="start" :icon="n.readAt ? mailOpenOutline : mailUnreadOutline" />
      <ion-label class="ion-text-wrap">
        <h3>{{ n.title ?? n.body }}</h3>
        <p v-if="n.title">{{ n.body }}</p>
        <p class="muted">{{ new Date(n.createdAt).toLocaleString() }}</p>
      </ion-label>
    </ion-item>
    <ion-item v-if="loaded && !items.length">
      <ion-label class="muted">You're all caught up.</ion-label>
    </ion-item>
  </ion-list>
  <ion-button fill="clear" size="small" router-link="/notifications">All notifications</ion-button>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { IonButton, IonIcon, IonItem, IonLabel, IonList } from '@ionic/vue';
import { mailOpenOutline, mailUnreadOutline } from 'ionicons/icons';
import type { InboxItemDto, ParentChildDto } from '@erp/shared';
import { inboxApi } from '@/modules/notifications/api';

// Inbox items are per user (not per child), so this card ignores the selected child.
defineProps<{ child: ParentChildDto }>();
const items = ref<InboxItemDto[]>([]);
const loaded = ref(false);

onMounted(async () => {
  try {
    items.value = (await inboxApi.list({ page: 1 })).items.slice(0, 5);
  } catch {
    items.value = [];
  } finally {
    loaded.value = true;
  }
});
</script>
