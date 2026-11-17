<template>
  <div v-if="auth.me?.impersonatedBy" class="banner">
    <span>
      Viewing as <strong>{{ auth.me.user.name }}</strong> ({{ auth.me.institute?.name }}) — impersonated by
      {{ auth.me.impersonatedBy.name }}. All actions are audited.
    </span>
    <ion-button size="small" color="light" @click="stop">Stop</ion-button>
  </div>
</template>

<script setup lang="ts">
import { IonButton } from '@ionic/vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const router = useRouter();

async function stop() {
  await auth.stopImpersonation();
  await router.replace('/admin/institutes');
}
</script>

<style scoped>
.banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1000;
  padding: 6px 12px;
  padding-bottom: calc(6px + var(--ion-safe-area-bottom, 0px));
  background: var(--ion-color-warning);
  color: var(--ion-color-warning-contrast);
  font-size: 13px;
}
</style>
