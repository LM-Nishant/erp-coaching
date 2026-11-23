import { defineModule } from '../../shared/module';
import { associateMarketplaceModels, initMarketplaceModels } from './models';
import { marketplaceRoutes } from './marketplace.routes';
import { associateEngagementModels, initEngagementModels } from './engagement.models';
import { registerEngagementNotificationEvents } from './engagement.notifications';
import { MKT_TRANSCODE_JOB, runMarketplaceTranscode } from './media.service';
import { initQuizModels } from './quiz-models';
import { MARKETPLACE } from './util';

// Catalogue entries must exist before any request calls notify().
registerEngagementNotificationEvents();

export default defineModule({
  name: MARKETPLACE,
  models: (sequelize) => {
    initMarketplaceModels(sequelize);
    initEngagementModels(sequelize);
    initQuizModels(sequelize);
  },
  associate: () => {
    associateMarketplaceModels();
    associateEngagementModels();
  },
  routes: marketplaceRoutes,
  permissions: [
    {
      // The institute's storefront on the public course marketplace. Independent instructors
      // manage their own courses without institute permissions.
      module: MARKETPLACE,
      label: 'Course marketplace',
      area: 'Learning & exams',
      describe: {
        view: ['View marketplace courses', "See the institute's marketplace courses, coupons and sales"],
        create: ['Create marketplace courses', 'Start new courses to sell on the marketplace'],
        edit: ['Edit marketplace courses', 'Change course details, curriculum, videos and files'],
        delete: ['Delete marketplace courses', 'Remove draft courses that were never published'],
        publish: ['Submit courses for review', 'Send courses for approval and take them off sale'],
        configure: ['Storefront and coupons', "Edit the institute's storefront profile and discount coupons"],
      },
      actions: ['view', 'create', 'edit', 'delete', 'publish', 'configure'],
      grants: {
        'branch-admin': 'all',
        teacher: ['view', 'create', 'edit'],
      },
    },
  ],
  jobs: {
    [MKT_TRANSCODE_JOB]: (payload) => runMarketplaceTranscode(payload as { mediaId: number }),
  },
});
