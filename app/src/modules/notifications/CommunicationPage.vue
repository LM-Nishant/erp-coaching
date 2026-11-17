<template>
  <AppPage title="Communication">
    <ion-segment :value="tab" scrollable @ion-change="tab = String($event.detail.value) as Tab">
      <ion-segment-button v-for="t in tabs" :key="t.id" :value="t.id">
        <ion-label>{{ t.label }}</ion-label>
      </ion-segment-button>
    </ion-segment>
    <HistoryTab v-if="tab === 'history'" />
    <CampaignsTab v-else-if="tab === 'campaigns'" />
    <TemplatesTab v-else-if="tab === 'templates'" />
    <RulesTab v-else-if="tab === 'rules'" />
    <ProvidersTab v-else-if="tab === 'providers'" />
  </AppPage>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { IonLabel, IonSegment, IonSegmentButton } from '@ionic/vue';
import AppPage from '@/components/AppPage.vue';
import { useAuthStore } from '@/stores/auth';
import HistoryTab from './components/HistoryTab.vue';
import CampaignsTab from './components/CampaignsTab.vue';
import TemplatesTab from './components/TemplatesTab.vue';
import RulesTab from './components/RulesTab.vue';
import ProvidersTab from './components/ProvidersTab.vue';

type Tab = 'history' | 'campaigns' | 'templates' | 'rules' | 'providers';
const auth = useAuthStore();
const tab = ref<Tab>('campaigns');
const tabs = computed(() =>
  (
    [
      { id: 'campaigns', label: 'Send' },
      { id: 'history', label: 'Delivery' },
      { id: 'templates', label: 'Templates' },
      { id: 'rules', label: 'Triggers' },
      { id: 'providers', label: 'Providers', permission: 'notifications.configure' as const },
    ] as { id: Tab; label: string; permission?: 'notifications.configure' }[]
  ).filter((t) => !t.permission || auth.can(t.permission)),
);
</script>
