import { defineModule } from '../../shared/module';
import { associateSubscriptionModels, initSubscriptionModels } from './models';
import { subscriptionRoutes } from './subscriptions.routes';

export default defineModule({
  name: 'subscriptions',
  models: initSubscriptionModels,
  associate: associateSubscriptionModels,
  routes: subscriptionRoutes,
  permissions: [{ module: 'subscription', label: 'Subscription & usage', actions: ['view'] }],
});
