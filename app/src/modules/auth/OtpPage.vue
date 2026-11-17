<template>
  <ion-page>
    <ion-header>
      <ion-toolbar>
        <ion-buttons slot="start"><ion-back-button default-href="/login" /></ion-buttons>
        <ion-title>Verify OTP</ion-title>
      </ion-toolbar>
    </ion-header>
    <ion-content class="ion-padding">
      <div v-if="auth.pendingOtp" class="wrap">
        <p>
          <template v-if="auth.pendingOtp.reason === 'new_device'">This is a new device. </template>
          Enter the 6-digit code sent to <strong>{{ auth.pendingOtp.maskedMobile }}</strong>.
        </p>
        <form @submit.prevent="verify">
          <ion-item lines="full">
            <ion-input
              v-model="code"
              label="OTP"
              label-placement="stacked"
              inputmode="numeric"
              autocomplete="one-time-code"
              :maxlength="6"
              required
            />
          </ion-item>
          <ion-text v-if="error" color="danger"
            ><p>{{ error }}</p></ion-text
          >
          <ion-button expand="block" type="submit" class="ion-margin-top" :disabled="busy || code.length < 4"
            >Verify</ion-button
          >
        </form>
      </div>
      <div v-else class="wrap">
        <p>No verification in progress.</p>
        <ion-button router-link="/login">Back to login</ion-button>
      </div>
    </ion-content>
  </ion-page>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  IonBackButton,
  IonButton,
  IonButtons,
  IonContent,
  IonHeader,
  IonInput,
  IonItem,
  IonPage,
  IonText,
  IonTitle,
  IonToolbar,
} from '@ionic/vue';
import { errorMessage } from '@/core/api';
import { useAuthStore } from '@/stores/auth';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const code = ref('');
const busy = ref(false);
const error = ref('');

async function verify() {
  busy.value = true;
  error.value = '';
  try {
    const next = await auth.verifyOtp(code.value.trim());
    if (next === 'device-limit')
      error.value = 'Device limit reached. Ask your institute admin to remove an old device.';
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
.wrap {
  max-width: 420px;
  margin: 4vh auto 0;
}
</style>
