<template>
  <ion-button
    v-if="enabled"
    router-link="/notifications"
    aria-label="Notifications"
    class="bell"
    data-testid="notification-bell"
  >
    <ion-icon slot="icon-only" :icon="notificationsOutline" />
    <ion-badge v-if="unread > 0" color="danger">{{ unread > 99 ? '99+' : unread }}</ion-badge>
  </ion-button>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { IonBadge, IonButton, IonIcon } from '@ionic/vue';
import { notificationsOutline } from 'ionicons/icons';
import { useAuthStore } from '@/stores/auth';
import { refreshUnread, registerPush, unread } from '../push';

const auth = useAuthStore();
const router = useRouter();
// Users without an institute (marketplace learners, independent instructors) get the personal inbox.
const enabled = computed(
  () => auth.personalInbox || (!!auth.me?.institute && auth.can('notification-inbox.view')),
);
let timer: ReturnType<typeof setInterval> | null = null;

function start() {
  if (timer) clearInterval(timer);
  timer = null;
  if (!enabled.value) return;
  void refreshUnread();
  // An impersonating admin's device must not take over the user's pushes.
  if ((auth.personalInbox || auth.can('notification-inbox.edit')) && !auth.me!.impersonatedBy)
    void registerPush(auth.me!.user.id, () => void router.push({ name: 'notifications-inbox' }));
  timer = setInterval(refreshUnread, 60_000);
}

onMounted(start);
// "Switch profile" keeps the page and this bell: the count and pushes follow the account now signed in.
watch(() => [auth.me?.user.id, auth.me?.institute?.id], start);
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
