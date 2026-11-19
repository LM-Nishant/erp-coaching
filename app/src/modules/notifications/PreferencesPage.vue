<template>
  <AppPage title="Notification preferences" back-href="/notifications">
    <p class="muted">
      Choose how you'd like to hear from {{ instituteName }}. Some important notices are always sent.
    </p>

    <ion-list>
      <ion-list-header><ion-label>Channels</ion-label></ion-list-header>
      <ion-item v-for="c in NOTIFICATION_CHANNELS" :key="c">
        <ion-toggle :checked="isEnabled(c, null)" @ion-change="set(c, null, $event.detail.checked)">
          {{ CHANNEL_LABELS[c] }}
        </ion-toggle>
      </ion-item>
      <ion-item v-if="!isEnabled('whatsapp', null)" lines="none">
        <ion-label class="muted">WhatsApp messages are sent only after you turn WhatsApp on.</ion-label>
      </ion-item>
    </ion-list>

    <ion-list v-for="group in groups" :key="group.category">
      <ion-list-header
        ><ion-label>{{ group.category }}</ion-label></ion-list-header
      >
      <ion-item v-for="e in group.events" :key="e.key">
        <ion-label>
          <h3>{{ e.label }}</h3>
          <p v-if="e.mandatory" class="muted">Always sent</p>
        </ion-label>
        <div slot="end" class="chips">
          <ion-chip
            v-for="c in e.defaultChannels"
            :key="c"
            :outline="!isEnabled(c, e.key)"
            :color="isEnabled(c, e.key) ? 'primary' : 'medium'"
            :disabled="e.mandatory || !isEnabled(c, null)"
            @click="set(c, e.key, !isEnabled(c, e.key))"
          >
            {{ CHANNEL_LABELS[c] }}
          </ion-chip>
        </div>
      </ion-item>
    </ion-list>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { IonChip, IonItem, IonLabel, IonList, IonListHeader, IonToggle } from '@ionic/vue';
import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENTS,
  type NotificationChannel,
  type NotificationEventDef,
  type NotificationPreferenceDto,
} from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import { CHANNEL_LABELS, inboxApi } from './api';

const auth = useAuthStore();
const instituteName = computed(() => auth.me?.institute?.name ?? 'your institute');
const prefs = ref<NotificationPreferenceDto[]>([]);

const groups = computed(() => {
  const map = new Map<string, NotificationEventDef[]>();
  for (const e of NOTIFICATION_EVENTS) map.set(e.category, [...(map.get(e.category) ?? []), e]);
  return [...map].map(([category, events]) => ({ category, events }));
});

function isEnabled(channel: NotificationChannel, eventKey: string | null): boolean {
  const own = prefs.value.find((p) => p.channel === channel && p.eventKey === eventKey);
  if (own) return own.enabled;
  if (eventKey === null) return true;
  return isEnabled(channel, null);
}

async function set(channel: NotificationChannel, eventKey: string | null, enabled: boolean) {
  try {
    prefs.value = await inboxApi.savePreferences([{ channel, eventKey, enabled }]);
    await toast('Preferences saved', 'medium');
  } catch (e) {
    await toastError(e);
  }
}

onMounted(async () => {
  try {
    prefs.value = await inboxApi.preferences();
  } catch (e) {
    await toastError(e);
  }
});
</script>

<style scoped>
.chips {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  max-width: 60%;
}
</style>
