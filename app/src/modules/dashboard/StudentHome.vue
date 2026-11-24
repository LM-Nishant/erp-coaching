<template>
  <AppPage :title="t('dashboard.student.title')" :on-refresh="refresh">
    <header class="hello">
      <div class="avatar" aria-hidden="true">{{ initial }}</div>
      <div>
        <h2>{{ t('dashboard.student.greeting', { name: firstName }) }}</h2>
        <p class="muted">{{ subtitle }}</p>
      </div>
    </header>

    <!-- `:key` remounts the cards (and so reloads them) on pull-to-refresh or a profile switch. -->
    <div :key="refreshKey" class="widgets">
      <section v-for="w in widgets" :key="w.id" :class="['widget', w.size ?? 'half']">
        <h3 class="eyebrow">{{ title(w) }}</h3>
        <component :is="w.component" />
      </section>
    </div>

    <QuickActions
      v-if="actions.length"
      :actions="actions"
      :label="t('dashboard.student.shortcuts')"
      class="actions"
    />
  </AppPage>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  calendarOutline,
  cloudDownloadOutline,
  documentTextOutline,
  libraryOutline,
  ribbonOutline,
  trophyOutline,
  videocamOutline,
  walletOutline,
} from 'ionicons/icons';
import { Capacitor } from '@capacitor/core';
import type { PermissionKey } from '@erp/shared';
import AppPage from '@/components/AppPage.vue';
import QuickActions, { type QuickAction } from '@/components/QuickActions.vue';
import { widgetsFor } from '@/core/modules';
import { useAuthStore } from '@/stores/auth';
import { useWidgetTitle } from './widget-title';

/** The student persona's "Today": next class, continue watching, due work and fees, then shortcuts. */
const { t } = useI18n();
const auth = useAuthStore();
const title = useWidgetTitle();
const refreshKey = ref(0);

const firstName = computed(() => auth.me?.user.name.split(' ')[0] ?? '');
const initial = computed(() => firstName.value.charAt(0).toUpperCase());
const subtitle = computed(() =>
  [auth.me?.institute?.name, auth.me?.branches.map((b) => b.name).join(', ')].filter(Boolean).join(' · '),
);

const allowed = (permission?: PermissionKey, planModule?: string) =>
  (!permission || auth.can(permission)) && (!planModule || auth.moduleEnabled(planModule));

const widgets = computed(() => widgetsFor('student-home').filter((w) => allowed(w.permission, w.planModule)));

const actions = computed<QuickAction[]>(() => {
  const all: (QuickAction & { permission: PermissionKey; planModule: string; native?: boolean })[] = [
    {
      id: 'live-classes.list',
      title: t('dashboard.student.actions.classes'),
      icon: videocamOutline,
      to: '/live-classes',
      permission: 'live-classes.view',
      planModule: 'live-classes',
    },
    {
      id: 'lms.courses',
      title: t('dashboard.student.actions.courses'),
      icon: libraryOutline,
      to: '/lms',
      permission: 'lms.view',
      planModule: 'lms',
    },
    {
      id: 'lms.homework',
      title: t('dashboard.student.actions.homework'),
      icon: documentTextOutline,
      to: '/lms/homework',
      permission: 'lms-assignments.view',
      planModule: 'lms',
    },
    {
      id: 'exams.my',
      title: t('dashboard.student.actions.tests'),
      icon: ribbonOutline,
      to: '/my-exams',
      permission: 'exam-portal.create',
      planModule: 'exams',
    },
    {
      id: 'exams.results',
      title: t('dashboard.student.actions.results'),
      icon: trophyOutline,
      to: '/exam-results',
      permission: 'exam-portal.view',
      planModule: 'exams',
    },
    {
      id: 'attendance.my',
      title: t('dashboard.student.actions.attendance'),
      icon: calendarOutline,
      to: '/attendance/my',
      permission: 'attendance-self.view',
      planModule: 'attendance',
    },
    {
      id: 'fees.my',
      title: t('dashboard.student.actions.fees'),
      icon: walletOutline,
      to: '/my-fees',
      permission: 'my-fees.view',
      planModule: 'fees',
    },
    {
      id: 'lms.offline',
      title: t('dashboard.student.actions.downloads'),
      icon: cloudDownloadOutline,
      to: '/lms/offline',
      permission: 'lms.view',
      planModule: 'lms',
      native: true,
    },
  ];
  return all
    .filter((a) => allowed(a.permission, a.planModule) && (!a.native || Capacitor.isNativePlatform()))
    .map(({ id, title: label, icon, to }) => ({ id, title: label, icon, to }));
});

async function refresh() {
  refreshKey.value++;
}

watch(() => [auth.me?.user.id, auth.me?.institute?.id, auth.activeBranchId], refresh);
</script>

<style scoped>
.hello {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 0 4px 12px;
}
.hello h2 {
  margin: 0;
  font-size: 1.4rem;
  font-weight: 700;
}
.hello p {
  margin: 2px 0 0;
}
.avatar {
  display: grid;
  place-items: center;
  flex: none;
  width: 48px;
  height: 48px;
  border-radius: 50%;
  font-weight: 700;
  font-size: 1.2rem;
  color: var(--ion-color-primary);
  background: rgba(var(--ion-color-primary-rgb), 0.12);
}
.widgets {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.widget {
  padding: 16px;
  border-radius: 16px;
  background: var(--ion-card-background, var(--ion-item-background, #fff));
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  min-width: 0;
}
.widget.full {
  grid-column: 1 / -1;
}
.eyebrow {
  margin: 0 0 10px;
  font-size: 0.8rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ion-color-medium-shade);
}
.actions {
  margin-top: 16px;
}
@media (max-width: 768px) {
  .widgets {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
