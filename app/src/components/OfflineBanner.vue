<template>
  <div v-if="auth.offline" class="banner" role="status">
    <ion-icon :icon="cloudOfflineOutline" />
    <span>Offline: only downloaded lectures are available.</span>
  </div>
</template>

<script setup lang="ts">
import { IonIcon } from '@ionic/vue';
import { cloudOfflineOutline } from 'ionicons/icons';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
</script>

<style scoped>
.banner {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1000;
  min-height: 36px;
  padding: 6px 12px;
  padding-bottom: calc(6px + var(--ion-safe-area-bottom, 0px));
  background: var(--ion-color-dark);
  color: var(--ion-color-dark-contrast);
  font-size: 13px;
}
</style>
