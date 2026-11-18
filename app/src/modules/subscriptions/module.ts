import { defineAsyncComponent } from 'vue';
import {
  cardOutline,
  documentTextOutline,
  ribbonOutline,
  settingsOutline,
  walletOutline,
} from 'ionicons/icons';
import { setPaymentRequiredHandler } from '@/core/api';
import { defineAppModule } from '@/core/modules';
import { handlePaymentRequired, suspendedGuard } from './status';

setPaymentRequiredHandler(handlePaymentRequired);

const admin = { superAdmin: true } as const;

export default defineAppModule({
  id: 'subscriptions',
  routes: [
    {
      path: '/subscription',
      name: 'subscription-billing',
      component: () => import('./BillingPage.vue'),
      meta: { permission: 'subscription.view', allowWhenSuspended: true },
    },
    {
      path: '/subscription/suspended',
      name: 'subscription-suspended',
      component: () => import('./SuspendedPage.vue'),
      meta: { allowWhenSuspended: true },
    },
    {
      path: '/admin/billing/subscriptions',
      name: 'admin-billing-subscriptions',
      component: () => import('./admin/SubscriptionsPage.vue'),
      meta: admin,
    },
    {
      path: '/admin/billing/institutes/:id',
      name: 'admin-billing-institute',
      component: () => import('./admin/InstituteBillingPage.vue'),
      meta: admin,
    },
    {
      path: '/admin/billing/invoices',
      name: 'admin-billing-invoices',
      component: () => import('./admin/InvoicesPage.vue'),
      meta: admin,
    },
    {
      path: '/admin/billing/payments',
      name: 'admin-billing-payments',
      component: () => import('./admin/PaymentsPage.vue'),
      meta: admin,
    },
    {
      path: '/admin/billing/settings',
      name: 'admin-billing-settings',
      component: () => import('./admin/BillingSettingsPage.vue'),
      meta: admin,
    },
  ],
  menu: [
    {
      title: 'Subscription & billing',
      path: '/subscription',
      icon: cardOutline,
      permission: 'subscription.view',
      order: 85,
    },
    {
      title: 'Subscriptions',
      path: '/admin/billing/subscriptions',
      icon: ribbonOutline,
      superAdmin: true,
      order: 12,
    },
    {
      title: 'SaaS invoices',
      path: '/admin/billing/invoices',
      icon: documentTextOutline,
      superAdmin: true,
      order: 14,
    },
    {
      title: 'SaaS payments',
      path: '/admin/billing/payments',
      icon: walletOutline,
      superAdmin: true,
      order: 16,
    },
    {
      title: 'Billing settings',
      path: '/admin/billing/settings',
      icon: settingsOutline,
      superAdmin: true,
      order: 25,
    },
  ],
  toolbarItems: [defineAsyncComponent(() => import('./components/SubscriptionStatusChip.vue'))],
  navigationGuards: [suspendedGuard],
});
