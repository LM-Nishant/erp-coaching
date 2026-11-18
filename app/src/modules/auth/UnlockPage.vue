<template>
  <ion-page>
    <ion-content class="ion-padding">
      <div class="auth-wrap">
        <div class="logo">
          <img :src="profile?.institute?.logoUrl || '/favicon.svg'" alt="" />
          <h1>{{ profile?.institute?.name ?? 'ERP Coaching' }}</h1>
          <p v-if="profile" class="muted">{{ profile.user.name }}</p>
        </div>

        <p v-if="notice" class="notice muted">{{ notice }}</p>

        <ion-button v-if="auth.canUnlock" expand="block" :disabled="busy" @click="unlock">
          <ion-spinner v-if="busy" name="dots" />
          <template v-else>
            <ion-icon slot="start" :icon="icon" />
            Unlock with {{ label }}
          </template>
        </ion-button>
        <ion-text v-if="error" color="danger"
          ><p class="error">{{ error }}</p></ion-text
        >
        <ion-button
          expand="block"
          :fill="auth.canUnlock ? 'clear' : 'solid'"
          :disabled="busy"
          @click="router.replace({ name: 'login', query: route.query })"
          >Use password or OTP</ion-button
        >
      </div>
    </ion-content>
  </ion-page>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { IonButton, IonContent, IonIcon, IonPage, IonSpinner, IonText, onIonViewDidEnter } from '@ionic/vue';
import { fingerPrintOutline, scanOutline } from 'ionicons/icons';
import type { MeDto } from '@erp/shared';
import { errorMessage } from '@/core/api';
import { BiometricError, biometricAvailability } from '@/core/biometric';
import { loadProfile } from '@/core/token-storage';
import { useAuthStore, type NextStep } from '@/stores/auth';

/** The app is locked (inactivity or a closed session) and biometric unlock is set up: Face ID / Touch ID / fingerprint. */
const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

const profile = ref<MeDto | null>(null);
const label = ref('biometrics');
const busy = ref(false);
const error = ref('');

const icon = computed(() => (/face/i.test(label.value) ? scanOutline : fingerPrintOutline));
const notice = computed(() =>
  auth.endReason === 'idle'
    ? 'Locked after a period of inactivity.'
    : auth.endReason === 'expired'
      ? 'Your session has ended. Unlock to continue.'
      : '',
);

onMounted(async () => {
  const [cached, availability] = await Promise.all([loadProfile(), biometricAvailability()]);
  profile.value = cached && cached.user.id === auth.biometric?.userId ? cached : null;
  if (availability.label) label.value = availability.label;
});

onIonViewDidEnter(() => {
  if (auth.canUnlock && !busy.value) void unlock();
});

async function unlock() {
  busy.value = true;
  error.value = '';
  try {
    await go(await auth.unlock());
  } catch (e) {
    if (!(e instanceof BiometricError && e.reason === 'cancelled')) error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}

async function go(next: NextStep) {
  if (next === 'otp') return router.push({ name: 'otp', query: route.query });
  if (next === 'device-limit') {
    error.value =
      'You are already signed in on the maximum number of devices. Sign in with your password or OTP.';
    return;
  }
  if (next === 'select-institute') return router.replace({ name: 'select-institute' });
  return router.replace((route.query.redirect as string) || '/home');
}
</script>

<style scoped>
.auth-wrap {
  max-width: 420px;
  margin: 12vh auto 0;
}
.logo {
  text-align: center;
  margin-bottom: 24px;
}
.logo img {
  width: 64px;
  height: 64px;
  object-fit: contain;
}
.logo h1 {
  margin: 8px 0 0;
}
.notice {
  text-align: center;
}
.error {
  white-space: pre-line;
  font-size: 14px;
}
</style>
