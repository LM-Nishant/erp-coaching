<template>
  <ion-button v-if="enabled" router-link="/notifications" aria-label="Notifications" class="bell">
    <ion-icon slot="icon-only" :icon="notificationsOutline" />
    <ion-badge v-if="unread > 0" color="danger">{{ unread > 99 ? '99+' : unread }}</ion-badge>
  </ion-button>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue';
import { IonBadge, IonButton, IonIcon } from '@ionic/vue';
import { notificationsOutline } from 'ionicons/icons';
import { useAuthStore } from '@/stores/auth';
import { refreshUnread, registerPush, unread } from '../push';

const auth = useAuthStore();
const enabled = computed(() => !!auth.me?.institute && auth.can('notification-inbox.view'));
let timer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  if (!enabled.value) return;
  void refreshUnread();
  if (auth.can('notification-inbox.edit')) void registerPush(auth.me!.user.id);
  timer = setInterval(refreshUnread, 60_000);
});
onUnmounted(() => timer && clearInterval(timer));
</script>

<style scoped>
.bell {
  position: relative;
}
.bell ion-badge {
  position: absolute;
  top: 2px;
  right: 0;
  font-size: 10px;
  padding: 2px 4px;
}
</style>
