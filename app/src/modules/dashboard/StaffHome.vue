<template>
  <div class="staff-home">
    <SetupChecklist v-if="auth.can('institute.configure')" />

    <QuickActions v-if="actions.length" :actions="actions" :label="t('dashboard.staff.quickActions')" />

    <WidgetGrid :widgets="widgets" class="home-widgets" />

    <CollectFeeSheet :is-open="collecting" @close="collecting = false" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  calendarOutline,
  checkboxOutline,
  layersOutline,
  megaphoneOutline,
  personAddOutline,
  walletOutline,
} from 'ionicons/icons';
import type { PermissionKey } from '@erp/shared';
import QuickActions, { type QuickAction } from '@/components/QuickActions.vue';
import { widgetsFor } from '@/core/modules';
import { useAuthStore } from '@/stores/auth';
import CollectFeeSheet from '../fees/CollectFeeSheet.vue';
import SetupChecklist from './SetupChecklist.vue';
import WidgetGrid from './WidgetGrid.vue';

/**
 * "Today" home of the staff persona (admin, branch admin, accountant, front desk): setup checklist until the
 * institute is ready, the everyday jobs as big buttons, then today's numbers from `staff-home` widgets.
 */
const auth = useAuthStore();
const { t } = useI18n();
const collecting = ref(false);

const allowed = (permission: PermissionKey, planModule: string) =>
  auth.can(permission) && auth.moduleEnabled(planModule);

const actions = computed<QuickAction[]>(() => {
  const list: (QuickAction & { show: boolean })[] = [
    {
      id: 'fees.collect',
      title: t('dashboard.staff.actions.collectFee'),
      icon: walletOutline,
      onClick: () => (collecting.value = true),
      show: allowed('fees.create', 'fees'),
    },
    {
      id: 'students.add',
      title: t('dashboard.staff.actions.addStudent'),
      icon: personAddOutline,
      to: { path: '/students', query: { add: '1' } },
      show: allowed('students.create', 'students'),
    },
    {
      id: 'notifications.send',
      title: t('dashboard.staff.actions.sendNotice'),
      icon: megaphoneOutline,
      to: { path: '/communication', query: { compose: '1' } },
      show: allowed('notifications.create', 'notifications'),
    },
    {
      id: 'admissions.enquiry',
      title: t('dashboard.staff.actions.newEnquiry'),
      icon: calendarOutline,
      to: { path: '/admissions/enquiries', query: { new: '1' } },
      show: allowed('admissions.create', 'admissions'),
    },
    {
      id: 'attendance.take',
      title: t('dashboard.staff.actions.attendance'),
      icon: checkboxOutline,
      to: '/attendance',
      show: allowed('attendance.create', 'attendance'),
    },
    {
      id: 'academics.batch',
      title: t('dashboard.staff.actions.newBatch'),
      icon: layersOutline,
      to: { path: '/academics/batches', query: { new: '1' } },
      show: allowed('academics.create', 'academics'),
    },
  ];
  return list.filter((a) => a.show).map(({ show: _show, ...a }) => a);
});

const widgets = computed(() =>
  widgetsFor('staff-home').filter(
    (w) => (!w.permission || auth.can(w.permission)) && (!w.planModule || auth.moduleEnabled(w.planModule)),
  ),
);
</script>

<style scoped>
.staff-home {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
</style>
