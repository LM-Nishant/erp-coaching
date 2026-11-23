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
      area: 'Institute',
      describe: {
        view: ['View website', 'See website pages and online forms'],
        create: ['Add pages', 'Create website pages and sections'],
        edit: ['Edit website', 'Change pages, menus and media'],
        delete: ['Delete pages', 'Remove website pages'],
        publish: ['Publish website', 'Make website changes live'],
        configure: ['Website setup', 'Domain, theme and SEO settings'],
      },
      actions: ['view', 'create', 'edit', 'delete', 'publish', 'configure'],
      grants: {
        'branch-admin': ['view', 'create', 'edit'],
        accountant: ['view'],
      },
    },
  ],
});
