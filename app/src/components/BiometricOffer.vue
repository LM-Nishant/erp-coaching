<template><span hidden /></template>

<script setup lang="ts">
import { watch } from 'vue';
import { useRoute } from 'vue-router';
import { alertController } from '@ionic/vue';
import {
  BiometricError,
  biometricAvailability,
  biometricDeclined,
  setBiometricDeclined,
} from '@/core/biometric';
import { toast, toastError } from '@/core/toast';
import { useAuthStore } from '@/stores/auth';

/**
 * After a password or OTP sign-in in the mobile app, offers Face ID / Touch ID / fingerprint unlock once (spec 4.18).
 * "Not now" is remembered per user; My devices can still turn it on.
 */
const auth = useAuthStore();
const route = useRoute();

watch(
  () => auth.freshLogin && !!auth.me && !auth.needsInstitute && !route.meta.public,
  async (ready) => {
    if (!ready) return;
    auth.freshLogin = false;
    const me = auth.me!;
    if (me.impersonatedBy || !me.session || auth.biometric?.userId === me.user.id) return;
    const { available, label } = await biometricAvailability();
    if (!available || (await biometricDeclined(me.user.id))) return;
    const alert = await alertController.create({
      header: `Unlock with ${label}?`,
      message: `Next time, open the app with ${label} instead of your password. You can turn this off in My devices.`,
      buttons: [
        { text: 'Not now', role: 'cancel' },
        { text: 'Turn on', role: 'confirm' },
      ],
    });
    await alert.present();
    const { role } = await alert.onDidDismiss();
    if (role !== 'confirm') {
      await setBiometricDeclined(me.user.id);
      return;
    }
    try {
      await auth.enableBiometric();
      await toast(`${label} unlock is on`);
    } catch (e) {
      if (!(e instanceof BiometricError && e.reason === 'cancelled')) await toastError(e);
    }
  },
  { immediate: true },
);
</script>
