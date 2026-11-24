<template>
  <MarketShell title="Purchase history" :search="false" :on-refresh="load">
    <ion-list v-if="orders.length">
      <ion-item v-for="o in orders" :key="o.id" :router-link="`/market/orders/${o.id}`" detail>
        <ion-label>
          <h3>{{ o.items.map((i) => i.title).join(', ') }}</h3>
          <p>{{ o.number }} · {{ formatDate(o.createdAt) }}</p>
        </ion-label>
        <div slot="end" class="end">
          <strong>{{ rupees(o.totalPaise) }}</strong>
          <ion-badge :color="STATUS_COLORS[o.status]">{{ o.status }}</ion-badge>
        </div>
      </ion-item>
    </ion-list>
    <p v-else-if="loaded" class="empty">No purchases yet.</p>
  </MarketShell>
</template>

<script setup lang="ts">
import { formatDate } from '@/core/format';
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { IonBadge, IonItem, IonLabel, IonList } from '@ionic/vue';
import type { MktOrderDto } from '@erp/shared';
import { toastError } from '@/core/toast';
import MarketShell from './components/MarketShell.vue';
import { marketApi, rupees } from './api';

const STATUS_COLORS: Record<string, string> = {
  paid: 'success',
  pending: 'warning',
  failed: 'danger',
  cancelled: 'medium',
  refunded: 'medium',
};
const route = useRoute();
const router = useRouter();
const orders = ref<MktOrderDto[]>([]);
const loaded = ref(false);

async function load() {
  try {
    orders.value = await marketApi.orders();
  } catch (e) {
    void toastError(e);
  } finally {
    loaded.value = true;
  }
}
// A redirect checkout comes back as /market/orders?payment=<order id>: the order page verifies it.
onMounted(() => {
  const returned = Number(route.query.payment);
  if (Number.isInteger(returned) && returned > 0)
    return router.replace({ path: `/market/orders/${returned}`, query: { payment: String(returned) } });
  return load();
});
</script>

<style scoped>
.end {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}
.empty {
  text-align: center;
  padding: 40px;
  color: var(--ion-color-medium);
}
</style>
