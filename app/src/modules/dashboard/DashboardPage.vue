<template>
  <!-- Students get their own "Today" page at /home (parents are sent to /parent-home by the router). -->
  <StudentHome v-if="auth.persona === 'student'" />
  <AppPage v-else :title="pageTitle" :on-refresh="refresh">
    <!-- The teacher persona gets a "Today" home (teacher-home widgets) instead of plan and usage numbers. -->
    <TeacherHome v-if="auth.persona === 'teacher'" :key="`teacher-${refreshKey}`" />
    <template v-else>
      <h2 class="hello">{{ t('dashboard.home.hello', { name: auth.me?.user.name }) }}</h2>

      <ion-grid v-if="auth.isPlatformAdmin && platform">
        <ion-row>
          <ion-col v-for="s in platform.institutesByStatus" :key="s.status" size="6" size-md="3">
            <StatCard :label="institutesLabel(s.status)" :value="s.count" />
          </ion-col>
          <ion-col size="6" size-md="3">
            <StatCard :label="t('dashboard.home.platform.users')" :value="platform.users" />
          </ion-col>
          <ion-col size="6" size-md="3">
            <StatCard :label="t('dashboard.home.platform.branches')" :value="platform.branches" />
          </ion-col>
        </ion-row>
      </ion-grid>

      <template v-else-if="!auth.isPlatformAdmin">
        <p class="muted">{{ [auth.me?.institute?.name, roles].filter(Boolean).join(' · ') }}</p>
        <StaffHome v-if="auth.persona === 'staff'" :key="`staff-${refreshKey}`" />
        <p v-else class="muted">
          {{
            t('dashboard.home.yourBranches', {
              names: auth.me?.branches.map((b) => b.name).join(', ') || '—',
            })
          }}
        </p>
      </template>
    </template>

    <!-- Module widgets for this audience; `:key` remounts them (and so reloads them) on refresh. -->
    <WidgetGrid :key="`widgets-${refreshKey}`" :widgets="widgets" class="shared-widgets" />
  </AppPage>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { IonCol, IonGrid, IonRow } from '@ionic/vue';
import AppPage from '@/components/AppPage.vue';
import StatCard from '@/components/StatCard.vue';
import { api } from '@/core/api';
import { widgetFitsPersona, widgetsFor } from '@/core/modules';
import { roleNames } from '@/core/roles';
import { useAuthStore } from '@/stores/auth';
import StaffHome from './StaffHome.vue';
import StudentHome from './StudentHome.vue';
import TeacherHome from './TeacherHome.vue';
import WidgetGrid from './WidgetGrid.vue';

interface PlatformStats {
  institutesByStatus: { status: string; count: number }[];
  users: number;
  branches: number;
}

const auth = useAuthStore();
const { t, te } = useI18n();
const pageTitle = computed(() =>
  auth.persona === 'teacher' ? t('dashboard.teacher.title') : t('dashboard.home.title'),
);
const roles = computed(() => roleNames(auth.me?.roles, t));
const institutesLabel = (status: string) => {
  const key = `dashboard.home.platform.statuses.${status}`;
  return t('dashboard.home.platform.institutes', { status: te(key) ? t(key) : status });
};
const platform = ref<PlatformStats | null>(null);

const refreshKey = ref(0);
const widgets = computed(() =>
  widgetsFor(auth.isPlatformAdmin ? 'platform-home' : 'home').filter(
    (w) =>
      (!w.permission || auth.can(w.permission)) &&
      (!w.planModule || auth.moduleEnabled(w.planModule)) &&
      widgetFitsPersona(w, auth.persona ?? undefined),
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
// Another branch, institute or profile on the same number (siblings usually share the institute). Only these
// ids, not the route: a getter returning a new array would reload every widget whenever the user leaves home.
watch(() => `${auth.me?.user.id}|${auth.me?.institute?.id}|${auth.activeBranchId}`, refresh);
</script>

<style scoped>
.hello {
  margin-top: 0;
}
.shared-widgets {
  margin-top: 12px;
}
</style>
