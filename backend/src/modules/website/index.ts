import { Router } from 'express';
import { defineModule } from '../../shared/module';
import { associateWebsiteModels, initWebsiteModels } from './models';
import { websitePublicRoutes } from './public.routes';
import { websiteRoutes } from './website.routes';

export default defineModule({
  name: 'website',
  models: initWebsiteModels,
  associate: associateWebsiteModels,
  routes: (api: Router) => {
    websitePublicRoutes(api);
    websiteRoutes(api);
  },
  permissions: [
    {
      module: 'website',
      label: 'Website & online admissions',
      actions: ['view', 'create', 'edit', 'delete', 'publish', 'configure'],
      grants: {
        'branch-admin': ['view', 'create', 'edit'],
        accountant: ['view'],
      },
    },
  ],
});
