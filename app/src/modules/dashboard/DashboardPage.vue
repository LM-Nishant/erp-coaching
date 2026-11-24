<template>
  <!-- Students get their own "Today" page at /home (parents are sent to /parent-home by the router). -->
  <StudentHome v-if="auth.persona === 'student'" />
  <AppPage v-else title="Dashboard" :on-refresh="refresh">
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
      <StaffHome v-if="auth.persona === 'staff'" :key="refreshKey" />
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
import AppPage from '@/components/AppPage.vue';
import StatCard from '@/components/StatCard.vue';
import { api } from '@/core/api';
import { widgetsFor } from '@/core/modules';
import { useAuthStore } from '@/stores/auth';
import StaffHome from './StaffHome.vue';
import StudentHome from './StudentHome.vue';

interface PlatformStats {
  institutesByStatus: { status: string; count: number }[];
  users: number;
  branches: number;
}

const auth = useAuthStore();
const route = useRoute();
const platform = ref<PlatformStats | null>(null);

const refreshKey = ref(0);
const widgets = computed(() =>
  widgetsFor(auth.isPlatformAdmin ? 'platform-home' : 'home').filter(
    (w) => (!w.permission || auth.can(w.permission)) && (!w.planModule || auth.moduleEnabled(w.planModule)),
  ),
);

async function load() {
  // Plan, storage and AI-token usage live on the billing page (/billing).
  if (auth.persona === 'student') return;
  if (auth.isPlatformAdmin) platform.value = await api.get<PlatformStats>('/admin/dashboard');
}

async function refresh() {
  refreshKey.value++;
  await load();
}

onMounted(load);
// Also another profile on the same number (siblings usually share the institute).
watch(() => [route.query.b, auth.me?.user.id, auth.me?.institute?.id, auth.activeBranchId], refresh);
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
