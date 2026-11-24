<template>
  <MarketShell title="Teach" back-href="/market" :search="false">
    <div class="wrap">
      <h1>Teach on the marketplace</h1>
      <p class="muted">
        Create video courses, articles and downloadable resources. Our team reviews each course before it goes
        live, then learners from everywhere can buy it. You earn on every sale; payouts are made monthly.
      </p>
      <template v-if="!auth.isAuthenticated">
        <ion-button
          expand="block"
          :router-link="{ name: 'market-signup', query: { redirect: '/market/teach' } }"
          >Create an account</ion-button
        >
        <ion-button
          expand="block"
          fill="outline"
          :router-link="{ name: 'login', query: { redirect: '/market/teach' } }"
          >Sign in</ion-button
        >
      </template>
      <template v-else-if="loaded">
        <h2>Your instructor profile</h2>
        <p class="muted">Learners see this on your courses and your instructor page.</p>
        <ProfileForm
          :profile="account?.instructor"
          :busy="busy"
          submit-label="Create instructor profile"
          @save="save"
        />
        <p v-if="account?.institute" class="muted">
          Selling as {{ account.institute.displayName }}?
          <router-link to="/market/studio/institute">Open the institute's storefront</router-link>
        </p>
      </template>
    </div>
  </MarketShell>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { IonButton } from '@ionic/vue';
import type { MktInstructorProfileInput } from '@erp/shared';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';
import MarketShell from './components/MarketShell.vue';
import ProfileForm from './studio/ProfileForm.vue';
import { marketApi } from './api';
import { useMarketAccount } from './store';

const auth = useAuthStore();
const router = useRouter();
const { account, refresh } = useMarketAccount();
const loaded = ref(false);
const busy = ref(false);

async function save(input: MktInstructorProfileInput) {
  busy.value = true;
  try {
    await marketApi.saveInstructorProfile(input);
    await refresh();
    await toast('Your instructor profile is ready');
    await router.replace('/market/studio/instructor');
  } catch (e) {
    void toastError(e);
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  if (!auth.isAuthenticated) return;
  const a = await refresh();
  if (a?.instructor) await router.replace('/market/studio/instructor');
  loaded.value = true;
});
</script>

<style scoped>
.wrap {
  max-width: 560px;
  margin: 0 auto;
}
.muted {
  color: var(--ion-color-medium-shade);
}
</style>
