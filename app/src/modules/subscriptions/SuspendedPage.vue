<template>
  <AppPage title="Subscription">
    <div class="notice">
      <ion-icon :icon="lockClosedOutline" color="danger" class="big" />
      <h2>{{ heading }}</h2>
      <p>{{ status?.message ?? 'Access to this institute is paused.' }}</p>
      <p class="muted">
        Ask your institute administrator to renew the subscription. Access returns as soon as it is paid.
      </p>
      <div class="actions">
        <ion-button v-if="auth.can('subscription.view')" router-link="/subscription">Open billing</ion-button>
        <ion-button
          v-if="(auth.me?.memberships.length ?? 0) > 1"
          fill="outline"
          router-link="/select-institute"
          >Switch institute</ion-button
        >
        <ion-button v-if="!active" fill="outline" @click="home">Continue</ion-button>
        <ion-button fill="clear" color="medium" @click="logout">Sign out</ion-button>
      </div>
    </div>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { IonButton, IonIcon } from '@ionic/vue';
import { lockClosedOutline } from 'ionicons/icons';
import AppPage from '@/components/AppPage.vue';
import { useAuthStore } from '@/stores/auth';
import { loadSubscriptionStatus, subscriptionState } from './status';

const auth = useAuthStore();
const router = useRouter();

const status = computed(() =>
  subscriptionState.instituteId === auth.me?.institute?.id ? subscriptionState.status : null,
);
/** Still suspended (or not yet known); otherwise the page offers a way back. */
const active = computed(() => !status.value || status.value.state === 'suspended');
const heading = computed(() =>
  status.value && status.value.state !== 'suspended'
    ? 'Access restored'
    : `${auth.me?.institute?.name ?? 'This institute'} is suspended`,
);

const home = () => router.replace('/home');

async function logout() {
  await auth.logout();
  await router.replace({ name: 'login' });
}

onMounted(() => void loadSubscriptionStatus(true).catch(() => undefined));
</script>

<style scoped>
.notice {
  max-width: 520px;
  margin: 48px auto;
  text-align: center;
}
.big {
  font-size: 56px;
}
.actions {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 16px;
}
</style>
