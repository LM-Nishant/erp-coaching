<template>
  <ion-page>
    <ion-content class="ion-padding">
      <div class="auth-wrap">
        <div class="logo">
          <img src="/favicon.svg" alt="" />
          <h1>ERP Coaching</h1>
          <p class="muted">Sign in to your institute</p>
        </div>

        <ion-segment v-model="mode">
          <ion-segment-button value="password"><ion-label>Password</ion-label></ion-segment-button>
          <ion-segment-button value="otp"><ion-label>Mobile OTP</ion-label></ion-segment-button>
        </ion-segment>

        <form @submit.prevent="submit">
          <ion-list lines="full" class="form-card">
            <template v-if="mode === 'password'">
              <ion-item>
                <ion-input
                  v-model="identifier"
                  label="Mobile or email"
                  label-placement="stacked"
                  autocomplete="username"
                  required
                />
              </ion-item>
              <ion-item>
                <ion-input
                  v-model="password"
                  label="Password"
                  label-placement="stacked"
                  type="password"
                  autocomplete="current-password"
                  required
                >
                  <ion-input-password-toggle slot="end" />
                </ion-input>
              </ion-item>
            </template>
            <ion-item v-else>
              <ion-input
                v-model="mobile"
                label="Mobile number"
                label-placement="stacked"
                type="tel"
                inputmode="tel"
                required
              />
            </ion-item>
          </ion-list>
          <ion-text v-if="error" color="danger"
            ><p class="error">{{ error }}</p></ion-text
          >
          <ion-button expand="block" type="submit" :disabled="busy" class="ion-margin-top">
            <ion-spinner v-if="busy" name="dots" />
            <span v-else>{{ mode === 'password' ? 'Sign in' : 'Send OTP' }}</span>
          </ion-button>
        </form>
      </div>
    </ion-content>
  </ion-page>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  IonButton,
  IonContent,
  IonInput,
  IonInputPasswordToggle,
  IonItem,
  IonLabel,
  IonList,
  IonPage,
  IonSegment,
  IonSegmentButton,
  IonSpinner,
  IonText,
} from '@ionic/vue';
import { errorMessage } from '@/core/api';
import { useAuthStore, type NextStep } from '@/stores/auth';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

const mode = ref<'password' | 'otp'>('password');
const identifier = ref('');
const password = ref('');
const mobile = ref('');
const busy = ref(false);
const error = ref('');

async function submit() {
  busy.value = true;
  error.value = '';
  try {
    const next =
      mode.value === 'password'
        ? await auth.loginWithPassword(identifier.value.trim(), password.value)
        : await auth.requestOtp(mobile.value.trim());
    await go(next);
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}

async function go(next: NextStep) {
  if (next === 'device-limit') {
    error.value =
      'You are already signed in on the maximum number of devices. Ask your institute admin to remove an old device.';
    return;
  }
  if (next === 'otp') return router.push({ name: 'otp', query: route.query });
  if (next === 'select-institute') return router.replace({ name: 'select-institute' });
  return router.replace((route.query.redirect as string) || '/home');
}
</script>

<style scoped>
.auth-wrap {
  max-width: 420px;
  margin: 8vh auto 0;
}
.logo {
  text-align: center;
  margin-bottom: 24px;
}
.logo img {
  width: 64px;
}
.logo h1 {
  margin: 8px 0 0;
}
.error {
  white-space: pre-line;
  font-size: 14px;
}
</style>
