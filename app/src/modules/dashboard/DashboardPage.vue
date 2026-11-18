<template>
  <AppPage title="Dashboard" :on-refresh="refresh">
    <h2 class="hello">Hello, {{ auth.me?.user.name }}</h2>

    <template v-if="auth.isPlatformAdmin">
      <ion-grid v-if="platform">
        <ion-row>
          <ion-col v-for="s in platform.institutesByStatus" :key="s.status" size="6" size-md="3">
            <StatCard :label="`${s.status} institutes`" :value="s.count" />
          </ion-col>
          <ion-col size="6" size-md="3"><StatCard label="Institute users" :value="platform.users" /></ion-col>
          <ion-col size="6" size-md="3"><StatCard label="Branches" :value="platform.branches" /></ion-col>
        </ion-row>
      </ion-grid>
    </template>

    <template v-else>
      <p class="muted cap">
        {{ auth.me?.institute?.name }} · {{ auth.me?.roles.join(', ').replace(/-/g, ' ') }}
      </p>
      <ion-grid v-if="sub">
        <ion-row>
          <ion-col size="6" size-md="3">
            <StatCard
              label="Plan"
              :value="sub.subscription?.plan?.name ?? '—'"
              :hint="sub.subscription?.status"
            />
          </ion-col>
          <ion-col size="6" size-md="3">
            <StatCard label="Branches" :value="sub.usage.branches" :hint="limit(sub.limits?.maxBranches)" />
          </ion-col>
          <ion-col size="6" size-md="3">
            <StatCard
              label="Storage (MB)"
              :value="sub.usage.storageMb"
              :hint="limit(sub.limits?.storageMb)"
            />
          </ion-col>
          <ion-col size="6" size-md="3">
            <StatCard
              label="AI tokens this month"
              :value="sub.usage.aiTokensThisMonth"
              :hint="limit(sub.limits?.aiTokensMonthly)"
            />
          </ion-col>
        </ion-row>
      </ion-grid>
      <ion-card v-else>
        <ion-card-content>
          Your branches: {{ auth.me?.branches.map((b) => b.name).join(', ') || '—' }}
        </ion-card-content>
      </ion-card>
    </template>

    <!-- Module widgets for this audience; `:key` remounts them (and so reloads them) on refresh. -->
    <div v-if="widgets.length" :key="refreshKey" class="widgets">
      <ion-card v-for="w in widgets" :key="w.id" :class="['widget', w.size ?? 'half']">
        <ion-card-header>
          <ion-card-title>{{ w.title }}</ion-card-title>
        </ion-card-header>
        <ion-card-content>
          <component :is="w.component" />
        </ion-card-content>
      </ion-card>
    </div>
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { IonCard, IonCardContent, IonCardHeader, IonCardTitle, IonCol, IonGrid, IonRow } from '@ionic/vue';
import type { PlanLimits } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import StatCard from '@/components/StatCard.vue';
import { api } from '@/core/api';
import { widgetsFor } from '@/core/modules';
import { useAuthStore } from '@/stores/auth';

interface SubscriptionInfo {
  subscription: { status: string; plan?: { name: string } } | null;
  limits: PlanLimits | null;
  usage: { branches: number; storageMb: number; aiTokensThisMonth: number };
}
interface PlatformStats {
  institutesByStatus: { status: string; count: number }[];
  users: number;
  branches: number;
}

const auth = useAuthStore();
const route = useRoute();
const sub = ref<SubscriptionInfo | null>(null);
const platform = ref<PlatformStats | null>(null);

const limit = (n: number | null | undefined) => (n === null || n === undefined ? 'unlimited' : `of ${n}`);

const refreshKey = ref(0);
const widgets = computed(() =>
  widgetsFor(auth.isPlatformAdmin ? 'platform-home' : 'home').filter(
    (w) => (!w.permission || auth.can(w.permission)) && (!w.planModule || auth.moduleEnabled(w.planModule)),
  ),
);

async function load() {
  if (auth.isPlatformAdmin) platform.value = await api.get<PlatformStats>('/admin/dashboard');
  else if (auth.can('subscription.view')) sub.value = await api.get<SubscriptionInfo>('/subscription');
}

async function refresh() {
  refreshKey.value++;
  await load();
}

onMounted(load);
watch(() => [route.query.b, auth.me?.institute?.id, auth.activeBranchId], refresh);
</script>

<style scoped>
.hello {
  margin-top: 0;
}
.cap {
  text-transform: capitalize;
}
.widgets {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.widget.full {
  grid-column: 1 / -1;
}
@media (max-width: 768px) {
  .widgets {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
