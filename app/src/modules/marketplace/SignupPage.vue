<template>
  <MarketShell title="Create your account" back-href="/market" :search="false">
    <div class="wrap">
      <h1>Sign up and start learning</h1>
      <p class="muted">One account for every course on the marketplace, on the web and in the app.</p>
      <form @submit.prevent="submit">
        <ion-list>
          <ion-item>
            <ion-input
              v-model="form.name"
              label="Full name"
              label-placement="stacked"
              autocomplete="name"
              required
              data-testid="signup-name"
            />
          </ion-item>
          <ion-item>
            <ion-input
              v-model="form.mobile"
              label="Mobile number"
              label-placement="stacked"
              type="tel"
              inputmode="tel"
              autocomplete="tel"
              required
              data-testid="signup-mobile"
            />
          </ion-item>
          <ion-item>
            <ion-input
              v-model="form.email"
              label="Email (optional)"
              label-placement="stacked"
              type="email"
              autocomplete="email"
            />
          </ion-item>
          <ion-item>
            <ion-input
              v-model="form.password"
              label="Password"
              label-placement="stacked"
              type="password"
              autocomplete="new-password"
              helper-text="At least 8 characters"
              required
              data-testid="signup-password"
            />
          </ion-item>
        </ion-list>
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <ion-button expand="block" type="submit" :disabled="busy" data-testid="signup-submit"
          >Create account</ion-button
        >
      </form>
      <p class="muted center">
        Already have an account?
        <router-link :to="{ name: 'login', query: { redirect } }">Sign in</router-link>
      </p>
    </div>
  </MarketShell>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { IonButton, IonInput, IonItem, IonList } from '@ionic/vue';
import { errorMessage } from '@/core/api';
import { useAuthStore } from '@/stores/auth';
import MarketShell from './components/MarketShell.vue';
import { marketApi } from './api';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/market';
const form = reactive({ name: '', mobile: '', email: '', password: '' });
const busy = ref(false);
const error = ref('');

async function submit() {
  busy.value = true;
  error.value = '';
  try {
    await marketApi.signup({
      name: form.name.trim(),
      mobile: form.mobile.trim(),
      email: form.email.trim() || null,
      password: form.password,
    });
    const next = await auth.loginWithPassword(form.mobile.trim(), form.password);
    if (next === 'otp') await router.replace({ name: 'otp', query: { redirect } });
    else await router.replace(redirect);
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.wrap {
  max-width: 460px;
  margin: 0 auto;
}
.muted {
  color: var(--ion-color-medium);
}
.center {
  text-align: center;
}
.error {
  color: var(--ion-color-danger);
}
</style>
