<template>
  <div class="certificate-banner" data-testid="certificate-banner">
    <ion-icon :icon="ribbonOutline" />
    <div class="text">
      <strong>Course complete!</strong>
      <span>Your certificate is ready.</span>
    </div>
    <div class="buttons">
      <ion-button
        size="small"
        data-testid="certificate-download"
        @click="openFileLink(certificatePdfUrl(code))"
        >Download PDF</ion-button
      >
      <ion-button size="small" fill="outline" :router-link="mktCertificateVerifyPath(code)">View</ion-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { IonButton, IonIcon } from '@ionic/vue';
import { ribbonOutline } from 'ionicons/icons';
import { mktCertificateVerifyPath } from '@erp/shared';
import { openFileLink } from '@/core/downloads';
import { certificatePdfUrl } from '../quiz-api';

defineProps<{ code: string }>();
</script>

<style scoped>
.certificate-banner {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  margin-bottom: 12px;
  border-radius: 8px;
  background: rgba(var(--ion-color-success-rgb), 0.14);
}
.certificate-banner > ion-icon {
  font-size: 28px;
  color: var(--ion-color-success-shade);
}
.text {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 160px;
}
.buttons {
  display: flex;
  gap: 4px;
}
</style>
