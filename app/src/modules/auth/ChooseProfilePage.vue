<template>
  <ion-page>
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start"><ion-back-button :default-href="leaveTo" /></ion-buttons>
        <ion-title>Who's signing in?</ion-title>
      </ion-toolbar>
    </ion-header>
    <ion-content class="ion-padding">
      <div class="page-container">
        <template v-if="auth.pendingProfiles">
          <p class="muted">This mobile number signs in to more than one account. Choose yours.</p>
          <ion-list>
            <ion-item
              v-for="p in auth.pendingProfiles.profiles"
              :key="p.id"
              button
              :disabled="busy"
              @click="choose(p)"
            >
              <ion-avatar slot="start">
                <span class="initial">{{ p.name[0] }}</span>
              </ion-avatar>
              <ion-label>
                <h2>{{ p.name }}</h2>
                <p v-for="m in p.memberships" :key="m.id">
                  <span class="cap">{{ m.roles.join(', ').replace(/-/g, ' ') }}</span> · {{ m.name }}
                </p>
              </ion-label>
              <ion-note v-if="auth.me?.user.id === p.id" slot="end" color="success">Signed in</ion-note>
            </ion-item>
          </ion-list>
          <ion-text v-if="error" color="danger"
            ><p>{{ error }}</p></ion-text
          >
        </template>
        <template v-else>
          <p>No sign-in in progress.</p>
          <ion-button :router-link="leaveTo">{{ auth.me ? 'Back to home' : 'Back to login' }}</ion-button>
        </template>
      </div>
    </ion-content>
  </ion-page>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  IonAvatar,
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonItem,
  IonLabel,
  IonList,
  IonNote,
  IonPage,
  IonText,
  IonTitle,
  IonToolbar,
} from '@ionic/vue';
import type { SignInProfileDto } from '@erp/shared';
import { errorMessage } from '@/core/api';
import { useAuthStore } from '@/stores/auth';

/**
 * After a mobile number is verified by OTP, when several accounts sign in with it (children sharing a parent's
 * mobile): pick the one signing in. Also the last step of "Switch profile".
 */
const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const busy = ref(false);
const error = ref('');
const leaveTo = computed(() => (auth.me ? '/home' : '/login'));

async function choose(profile: SignInProfileDto) {
  busy.value = true;
  error.value = '';
  try {
    const next = await auth.selectProfile(profile.id);
    if (next === 'device-limit')
      error.value = `${profile.name} is already signed in on the maximum number of devices. Sign out of one in "My devices" on another device, or ask the institute admin to remove an old device.`;
    else if (next === 'select-institute') await router.replace({ name: 'select-institute' });
    else await router.replace((route.query.redirect as string) || '/home');
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
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
  background: var(--ion-color-primary);
}
.cap {
  text-transform: capitalize;
}
</style>
