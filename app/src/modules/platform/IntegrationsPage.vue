<template>
  <AppPage title="Integrations" :on-refresh="load">
    <ion-segment :value="tab" scrollable @ion-change="tab = String($event.detail.value) as Tab">
      <ion-segment-button value="gateways"><ion-label>Payment gateways</ion-label></ion-segment-button>
      <ion-segment-button value="messaging"><ion-label>Notification providers</ion-label></ion-segment-button>
      <ion-segment-button value="storage"><ion-label>Storage</ion-label></ion-segment-button>
      <ion-segment-button value="live"><ion-label>Live classes</ion-label></ion-segment-button>
    </ion-segment>

    <div v-if="loading && !data" class="center"><ion-spinner /></div>
    <template v-else-if="data">
      <template v-if="tab === 'gateways'">
        <p class="muted hint">
          The gateway marked for subscription payments collects SaaS invoices from institutes. A gateway
          offered to institutes is their fee-collection fallback: an institute's own enabled gateway always
          takes precedence. Credentials are encrypted at rest, and enabling a gateway runs a connection test
          first.
        </p>
        <GatewayCard v-for="g in data.gateways" :key="g.gateway" :dto="g" @saved="load" />
      </template>
      <template v-else-if="tab === 'messaging'">
        <p class="muted hint">
          Platform defaults per channel. They send login OTPs and act as the fallback for institutes without a
          provider of their own; an institute's provider always takes precedence. Without one the built-in
          console provider logs messages instead of sending them.
        </p>
        <MessagingCard v-for="m in data.messaging" :key="m.channel" :dto="m" @saved="load" />
      </template>
      <template v-else-if="tab === 'live'">
        <p class="muted hint">
          The media server that carries live-class audio and video, records classes and reports attendance.
        </p>
        <LiveStreamingCard ref="liveCard" />
      </template>
      <template v-else>
        <p class="muted hint">
          Where uploaded files (documents, media, exports) are stored for every institute. Credentials are
          encrypted at rest.
        </p>
        <StorageCard :dto="data.storage" @saved="load" />
      </template>
    </template>
  </AppPage>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { IonLabel, IonSegment, IonSegmentButton, IonSpinner } from '@ionic/vue';
import type { PlatformIntegrationsDto } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import { toastError } from '@/core/toast';
import { platformApi } from './api';
import GatewayCard from './components/GatewayCard.vue';
import MessagingCard from './components/MessagingCard.vue';
import StorageCard from './components/StorageCard.vue';
import LiveStreamingCard from './components/LiveStreamingCard.vue';

type Tab = 'gateways' | 'messaging' | 'storage' | 'live';
const tab = ref<Tab>('gateways');
const data = ref<PlatformIntegrationsDto | null>(null);
const loading = ref(false);
const liveCard = ref<InstanceType<typeof LiveStreamingCard> | null>(null);

async function load() {
  loading.value = true;
  void liveCard.value?.load();
  try {
    data.value = await platformApi.integrations();
  } catch (e) {
    await toastError(e);
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.hint {
  font-size: 13px;
  margin: 12px 4px;
}
.center {
  display: flex;
  justify-content: center;
  padding: 32px;
}
</style>
