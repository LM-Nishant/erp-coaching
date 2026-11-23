import { sparklesOutline } from 'ionicons/icons';
import { defineAppModule } from '@/core/modules';

export default defineAppModule({
  id: 'ai',
  routes: [
    {
      path: '/ai-usage',
      name: 'ai-usage',
      component: () => import('./AiUsagePage.vue'),
      meta: { permission: 'ai.view' },
    },
  ],
  menu: [
    {
      title: 'AI usage',
      path: '/ai-usage',
      group: 'settings',
      titleKey: 'nav.ai.usage',
      icon: sparklesOutline,
      permission: 'ai.view',
      planModule: 'ai',
      order: 88,
    },
  ],
});
