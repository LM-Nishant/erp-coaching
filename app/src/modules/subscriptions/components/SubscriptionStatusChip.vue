<template>
  <ion-chip
    v-if="chip"
    class="subscription-chip"
    :color="chip.color"
    :title="chip.detail ?? chip.label"
    :aria-label="`Subscription: ${chip.label}`"
    @click="open"
  >
    <ion-icon :icon="chip.color === 'danger' ? alertCircleOutline : timeOutline" />
    <ion-label>{{ chip.label }}</ion-label>
  </ion-chip>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { IonChip, IonIcon, IonLabel, alertController } from '@ionic/vue';
import { alertCircleOutline, timeOutline } from 'ionicons/icons';
import { useAuthStore } from '@/stores/auth';
import { statusChip } from '../format';
import {
  loadSubscriptionStatus,
  mustLeaveForSuspension,
  subscriptionState,
  suspendedTarget,
} from '../status';

const auth = useAuthStore();
const router = useRouter();

const chip = computed(() =>
  auth.me?.institute && subscriptionState.instituteId === auth.me.institute.id
    ? statusChip(subscriptionState.status)
    : null,
);

const refresh = () => void loadSubscriptionStatus().catch(() => undefined);
onMounted(refresh);
watch(() => auth.me?.institute?.id, refresh);

// A 402 mid-session (e.g. the sweep suspended the institute) leaves pages that would only fail now.
watch(
  () => subscriptionState.status?.state,
  () => {
    if (mustLeaveForSuspension(router.currentRoute.value.meta)) void router.replace(suspendedTarget());
  },
);

async function open() {
  const s = subscriptionState.status;
  if (!s) return;
  if (s.canManage && auth.can('subscription.view')) {
    await router.push({ name: 'subscription-billing' });
    return;
  }
  const alert = await alertController.create({
    header: chip.value?.label ?? 'Subscription',
    message: s.message ?? 'Contact your institute administrator.',
    buttons: ['OK'],
  });
  await alert.present();
}
</script>

<style scoped>
.subscription-chip {
  margin: 0 4px;
  height: 28px;
  font-size: 13px;
}
@media (max-width: 575px) {
  .subscription-chip ion-label {
    display: none;
  }
  .subscription-chip ion-icon {
    margin: 0;
  }
}
</style>
