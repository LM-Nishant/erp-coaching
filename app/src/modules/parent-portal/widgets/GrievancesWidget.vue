<template>
  <ion-list lines="none">
    <ion-item v-for="t in items" :key="t.id" button detail :router-link="`/grievances/${t.id}`">
      <ion-label class="ion-text-wrap">
        <h3>{{ t.subject }}</h3>
        <p>{{ t.ticketNumber }} · {{ t.categoryName }}<span v-if="!t.onBehalfOf"> · general</span></p>
      </ion-label>
      <ion-badge slot="end" :color="STATUS_COLORS[t.status]">{{ t.status.replace('_', ' ') }}</ion-badge>
    </ion-item>
    <ion-item v-if="loaded && !items.length">
      <ion-label class="muted ion-text-wrap">No open complaints or requests.</ion-label>
    </ion-item>
  </ion-list>
  <ion-button v-if="auth.can('grievances.create')" fill="clear" size="small" router-link="/grievances/new"
    >Raise a request</ion-button
  >
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { IonBadge, IonButton, IonItem, IonLabel, IonList } from '@ionic/vue';
import type { GrievanceTicketDto, ParentChildDto } from '@erp/shared';
import { useAuthStore } from '@/stores/auth';
import { STATUS_COLORS, grievancesApi } from '@/modules/grievances/api';

const props = defineProps<{ child: ParentChildDto }>();
const auth = useAuthStore();
const items = ref<GrievanceTicketDto[]>([]);
const loaded = ref(false);

// Tickets are keyed by the student's user id; tickets not raised for a specific child show for every child.
watch(
  () => props.child.studentUserId,
  async (studentUserId) => {
    loaded.value = false;
    try {
      const page = await grievancesApi.mine({ pageSize: 20 });
      items.value = page.items
        .filter((t) => !t.onBehalfOf || t.onBehalfOf.id === studentUserId)
        .filter((t) => t.status !== 'closed')
        .slice(0, 5);
    } catch {
      items.value = [];
    } finally {
      loaded.value = true;
    }
  },
  { immediate: true },
);
</script>
