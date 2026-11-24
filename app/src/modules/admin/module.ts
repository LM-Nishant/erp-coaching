import {
  businessOutline,
  layersOutline,
  peopleOutline,
  receiptOutline,
  sparklesOutline,
} from 'ionicons/icons';
import { defineAppModule } from '@/core/modules';

const meta = { superAdmin: true } as const;

export default defineAppModule({
  id: 'admin',
  routes: [
    {
      path: '/admin/institutes',
      name: 'admin-institutes',
      component: () => import('./InstitutesPage.vue'),
      meta,
    },
    { path: '/admin/users', name: 'admin-users', component: () => import('./UsersPage.vue'), meta },
    { path: '/admin/plans', name: 'admin-plans', component: () => import('./PlansPage.vue'), meta },
    { path: '/admin/ai', name: 'admin-ai', component: () => import('./AiConfigPage.vue'), meta },
    { path: '/admin/audit', name: 'admin-audit', component: () => import('./AuditPage.vue'), meta },
  ],
  menu: [
    {
      title: 'Institutes',
      path: '/admin/institutes',
      group: 'platform',
      titleKey: 'nav.admin.institutes',
      tab: { platform: 2 },
      tabTitleKey: 'nav.tabs.institutes',
      icon: businessOutline,
      superAdmin: true,
      order: 10,
    },
    {
      title: 'Users & devices',
      path: '/admin/users',
      group: 'platform',
      titleKey: 'nav.admin.users',
      tab: { platform: 3 },
      tabTitleKey: 'nav.tabs.users',
      icon: peopleOutline,
      superAdmin: true,
      order: 15,
    },
    {
      title: 'Plans',
      path: '/admin/plans',
      group: 'platform',
      titleKey: 'nav.admin.plans',
      icon: layersOutline,
      superAdmin: true,
      order: 20,
    },
    {
      title: 'AI configuration',
      path: '/admin/ai',
      group: 'platform',
      titleKey: 'nav.admin.ai',
      icon: sparklesOutline,
      superAdmin: true,
      order: 30,
    },
    {
      title: 'Audit log',
      path: '/admin/audit',
      group: 'platform',
      titleKey: 'nav.admin.audit',
      icon: receiptOutline,
      superAdmin: true,
      order: 40,
    },
  ],
});
