<template>
  <div class="teacher-home">
    <p class="date">{{ formatDayShort(new Date()) }}</p>
    <h2 class="hello">{{ t(`dashboard.teacher.${greeting}`, { name: firstName }) }}</h2>

    <QuickActions v-if="actions.length" :actions="actions" :label="t('dashboard.teacher.quickActions')" />

    <WidgetGrid :widgets="widgets" class="home-widgets" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  calendarOutline,
  checkmarkDoneOutline,
  cloudUploadOutline,
  createOutline,
  videocamOutline,
} from 'ionicons/icons';
import type { PermissionKey } from '@erp/shared';
import QuickActions, { type QuickAction } from '@/components/QuickActions.vue';
import { formatDayShort } from '@/core/format';
import { widgetsFor } from '@/core/modules';
import { useAuthStore } from '@/stores/auth';
import { greetingFor } from './teacher-home';
import WidgetGrid from './WidgetGrid.vue';

const { t } = useI18n();
const auth = useAuthStore();

const firstName = computed(() => auth.me?.user.name.split(' ')[0] ?? '');
const greeting = greetingFor(new Date().getHours());

const allowed = (permission?: PermissionKey, planModule?: string) =>
  (!permission || auth.can(permission)) && (!planModule || auth.moduleEnabled(planModule));

const actions = computed<QuickAction[]>(() =>
  (
    [
      {
        id: 'attendance.take',
        icon: checkmarkDoneOutline,
        to: '/attendance',
        p: 'attendance.create',
        m: 'attendance',
      },
      {
        id: 'lms.homework',
        icon: createOutline,
        to: '/lms/homework/new',
        p: 'lms-assignments.edit',
        m: 'lms',
      },
      { id: 'exams.new', icon: calendarOutline, to: '/exams/new', p: 'exams.create', m: 'exams' },
      {
        id: 'lms.upload',
        icon: cloudUploadOutline,
        to: '/lms/content/new?type=video',
        p: 'lms.create',
        m: 'lms',
      },
      {
        id: 'live.classes',
        icon: videocamOutline,
        to: '/live-classes',
        p: 'live-classes.view',
        m: 'live-classes',
      },
    ] as const
  )
    .filter((a) => allowed(a.p as PermissionKey, a.m))
    .map((a) => ({
      id: a.id,
      icon: a.icon,
      to: a.to,
      title: t(`dashboard.teacher.actions.${a.id.split('.')[1]}`),
    })),
);

const widgets = computed(() => widgetsFor('teacher-home').filter((w) => allowed(w.permission, w.planModule)));
</script>

<style scoped>
.date {
  margin: 0;
  color: var(--ion-color-medium-shade);
  font-size: 14px;
}
.hello {
  margin: 2px 0 16px;
  font-size: 24px;
  font-weight: 700;
}
.home-widgets {
  margin-top: 16px;
}
</style>
