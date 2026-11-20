import { swapHorizontalOutline } from 'ionicons/icons';
import { defineAppModule } from '@/core/modules';

/** Tally accounting export: ledger mapping, TallyPrime / Tally.ERP 9 XML files and reconciliation. */
export default defineAppModule({
  id: 'tally',
  routes: [
    {
      path: '/accounting/tally',
      name: 'tally-exports',
      component: () => import('./TallyExportPage.vue'),
      meta: { permission: 'tally.view' },
    },
    {
      path: '/accounting/tally/settings',
      name: 'tally-settings',
      component: () => import('./TallySettingsPage.vue'),
      meta: { permission: 'tally.view' },
    },
    {
      path: '/accounting/tally/exports/:id',
      name: 'tally-export',
      component: () => import('./TallyExportDetailPage.vue'),
      meta: { permission: 'tally.view' },
    },
  ],
  menu: [
    {
      title: 'Tally export',
      path: '/accounting/tally',
      icon: swapHorizontalOutline,
      permission: 'tally.view',
      // The backend serves Tally under the fees module of the plan.
      planModule: 'fees',
      order: 65,
    },
  ],
});
