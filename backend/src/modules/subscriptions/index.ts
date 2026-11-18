import { defineModule } from '../../shared/module';
import { addTenantRequestGuard } from '../../shared/middleware/authenticate';
import { associateSubscriptionModels, initSubscriptionModels } from './models';
import { subscriptionRoutes } from './subscriptions.routes';
import { subscriptionAccessGuard } from './access-guard';
import { registerBillingNotificationEvents } from './notifications';
import { registerSubscriptionIntegrations } from './integrations';
import { BILLING_SWEEP_JOB, billingSweepJob, scheduleBillingSweep } from './sweep.service';

export default defineModule({
  name: 'subscriptions',
  models: initSubscriptionModels,
  associate: associateSubscriptionModels,
  routes: subscriptionRoutes,
  permissions: [
    {
      module: 'subscription',
      label: 'Subscription & billing',
      actions: ['view', 'edit'],
    },
  ],
  jobs: { [BILLING_SWEEP_JOB]: billingSweepJob },
  onReady: async () => {
    registerBillingNotificationEvents();
    registerSubscriptionIntegrations();
    addTenantRequestGuard('subscription-access', subscriptionAccessGuard);
    await scheduleBillingSweep();
  },
});
