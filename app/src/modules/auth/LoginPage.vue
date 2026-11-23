<template>
  <ion-page>
    <ion-content class="ion-padding">
      <div class="auth-wrap">
        <div class="languages" role="group" :aria-label="t('auth.login.chooseLanguage')">
          <button
            v-for="l in LOCALES"
            :key="l"
            type="button"
            class="lang"
            :class="{ active: locale === l }"
            :aria-pressed="locale === l"
            :lang="l"
            @click="setLocale(l)"
          >
            {{ LOCALE_NAMES[l] }}
          </button>
        </div>
        <div class="logo">
          <img src="/favicon.svg" alt="" />
          <h1>ERP Coaching</h1>
          <p class="muted">{{ t('auth.login.subtitle') }}</p>
        </div>

        <ion-text v-if="notice" color="warning"
          ><p class="notice">{{ notice }}</p></ion-text
        >
        <ion-button
          v-if="auth.canUnlock"
          expand="block"
          fill="outline"
          class="unlock"
          @click="router.replace({ name: 'unlock', query: route.query })"
        >
          <ion-icon slot="start" :icon="fingerPrintOutline" />
          {{ t('auth.login.unlock') }}
        </ion-button>

        <ion-segment v-model="mode">
          <ion-segment-button value="otp"
            ><ion-label>{{ t('auth.login.modeOtp') }}</ion-label></ion-segment-button
          >
          <ion-segment-button value="password"
            ><ion-label>{{ t('auth.login.modePassword') }}</ion-label></ion-segment-button
          >
        </ion-segment>

        <form @submit.prevent="submit">
          <ion-list lines="full" class="form-card">
            <template v-if="mode === 'password'">
              <ion-item>
                <ion-input
                  v-model="identifier"
                  :label="t('auth.login.identifier')"
                  label-placement="stacked"
                  autocomplete="username"
                  required
                />
              </ion-item>
              <ion-item>
                <ion-input
                  v-model="password"
                  :label="t('auth.login.password')"
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
                :label="t('auth.login.mobile')"
                label-placement="stacked"
                :helper-text="t('auth.login.mobileHelp')"
                type="tel"
                inputmode="tel"
                autocomplete="tel"
                required
              />
            </ion-item>
          </ion-list>
          <ion-text v-if="error" color="danger"
            ><p class="error">{{ error }}</p></ion-text
          >
          <ion-button expand="block" type="submit" :disabled="busy" class="ion-margin-top">
            <ion-spinner v-if="busy" name="dots" />
            <span v-else>{{ mode === 'password' ? t('auth.login.signIn') : t('auth.login.sendOtp') }}</span>
          </ion-button>
        </form>
        <p class="market-links">
          <router-link to="/market">{{ t('auth.login.browse') }}</router-link> ·
          <router-link :to="{ name: 'market-signup', query: route.query }">{{
            t('auth.login.createLearner')
          }}</router-link>
        </p>
      </div>
    </ion-content>
  </ion-page>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import {
  IonButton,
  IonContent,
  IonIcon,
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
import { fingerPrintOutline } from 'ionicons/icons';
import { errorMessage } from '@/core/api';
import { LOCALE_NAMES, LOCALES, setLocale } from '@/i18n';
import { useAuthStore, type NextStep } from '@/stores/auth';

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const { t, locale } = useI18n();

// Most students and parents know their mobile number, not a password: OTP first.
const mode = ref<'password' | 'otp'>('otp');
const identifier = ref('');
const password = ref('');
const mobile = ref('');
const busy = ref(false);
const error = ref('');

/** Why the last session ended (inactivity, device signed out by an admin…). */
const ENDED = ['idle', 'revoked', 'inactive', 'expired'];
const notice = computed(() =>
  auth.endReason && ENDED.includes(auth.endReason) ? t(`auth.login.ended.${auth.endReason}`) : '',
);

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
    error.value = t('auth.login.deviceLimit');
    return;
  }
  if (next === 'otp') return router.push({ name: 'otp', query: route.query });
  if (next === 'choose-profile') return router.replace({ name: 'choose-profile', query: route.query });
  if (next === 'select-institute') return router.replace({ name: 'select-institute' });
  return router.replace((route.query.redirect as string) || '/home');
}
</script>

<style scoped>
.market-links {
  text-align: center;
  font-size: 14px;
}
.auth-wrap {
  max-width: 420px;
  margin: 4vh auto 0;
}
.languages {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-bottom: 8px;
}
.lang {
  min-height: var(--app-tap-target);
  padding: 0 16px;
  border: 1px solid var(--ion-color-medium);
  border-radius: 999px;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.lang.active {
  border-color: var(--ion-color-primary);
  background: var(--ion-color-primary);
  color: var(--ion-color-primary-contrast);
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
.notice {
  text-align: center;
  font-size: 14px;
}
.unlock {
  margin-bottom: 16px;
}
</style>
