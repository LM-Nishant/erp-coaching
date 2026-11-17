<template>
  <ion-page>
    <ion-header>
      <ion-toolbar><ion-title>Choose institute</ion-title></ion-toolbar>
    </ion-header>
    <ion-content class="ion-padding">
      <div class="page-container">
        <ion-list>
          <ion-item
            v-for="m in auth.me?.memberships ?? []"
            :key="m.id"
            button
            :disabled="busy"
            @click="choose(m.id)"
          >
            <ion-avatar slot="start" :style="{ background: m.primaryColor ?? 'var(--ion-color-primary)' }">
              <img v-if="m.logoUrl" :src="m.logoUrl" alt="" />
              <span v-else class="initial">{{ m.name[0] }}</span>
            </ion-avatar>
            <ion-label>
              <h2>{{ m.name }}</h2>
              <p class="cap">{{ m.roles.join(', ').replace(/-/g, ' ') }}</p>
            </ion-label>
            <ion-icon
              v-if="auth.me?.institute?.id === m.id"
              slot="end"
              :icon="checkmarkCircle"
              color="success"
            />
          </ion-item>
        </ion-list>
        <ion-button fill="clear" color="medium" @click="logout">Sign out</ion-button>
      </div>
    </ion-content>
  </ion-page>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  IonAvatar,
  IonButton,
  IonContent,
  IonHeader,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonPage,
  IonTitle,
  IonToolbar,
} from '@ionic/vue';
import { checkmarkCircle } from 'ionicons/icons';
import { useAuthStore } from '@/stores/auth';
import { toastError } from '@/core/toast';

const auth = useAuthStore();
const router = useRouter();
const busy = ref(false);

async function choose(id: number) {
  busy.value = true;
  try {
    await auth.selectInstitute(id);
    await router.replace('/home');
  } catch (e) {
    await toastError(e);
  } finally {
    busy.value = false;
  }
}

async function logout() {
  await auth.logout();
  await router.replace({ name: 'login' });
}
</script>

<style scoped>
.initial {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #fff;
  font-weight: 600;
}
.cap {
  text-transform: capitalize;
}
</style>
