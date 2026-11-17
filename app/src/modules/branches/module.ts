import { gitBranchOutline } from 'ionicons/icons';
import { defineAppModule } from '@/core/modules';

/** Reference module: copy this folder's shape for new feature modules. */
export default defineAppModule({
  id: 'branches',
  routes: [
    {
      path: '/branches',
      name: 'branches',
      component: () => import('./BranchesPage.vue'),
      meta: { permission: 'branches.view' },
    },
  ],
  menu: [
    { title: 'Branches', path: '/branches', icon: gitBranchOutline, permission: 'branches.view', order: 20 },
  ],
});
