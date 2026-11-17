<template>
  <AppPage title="Access denied">
    <div class="ion-text-center">
      <h2>You don't have permission to open this page.</h2>
      <ion-button router-link="/home">Go home</ion-button>
    </div>
  </AppPage>
</template>

<script setup lang="ts">
import { IonButton } from '@ionic/vue';
import AppPage from '@/components/AppPage.vue';
</script>
