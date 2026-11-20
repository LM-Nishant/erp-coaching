import { defineModule } from '../../shared/module';
import { associateFeeModels, initFeeModels } from './models';
import { feesRoutes } from './fees.routes';
import { registerFeesIntegrations } from './integrations';
import { registerFeeNotificationEvents } from './notifications';
import { COURSE_ENROLMENT_JOB, courseEnrolmentJob } from './course-enrolment';
import {
  FEES_INSTITUTE_SWEEP_JOB,
  FEES_PAYMENT_RECONCILE_JOB,
  FEES_SWEEP_JOB,
  runFeesSweep,
  runInstituteSweep,
  runPaymentReconcile,
  scheduleFeesSweep,
  schedulePaymentReconcile,
} from './jobs';

export default defineModule({
  name: 'fees',
  models: initFeeModels,
  associate: associateFeeModels,
  routes: feesRoutes,
  permissions: [
    {
      module: 'fees',
      label: 'Fees & payments',
      area: 'Finance',
      describe: {
        view: ['View fees', 'See fee structures, dues, payments and receipts'],
        create: ['Collect fees', 'Record payments, issue receipts and assign fees'],
        edit: ['Edit fees', 'Change fee plans and request discounts or refunds'],
        delete: ['Cancel fee entries', 'Cancel receipts and remove fee assignments'],
        approve: ['Approve fee changes', 'Approve refunds, discounts and offline receipts'],
        export: ['Export fees', 'Download fee collections, dues and receipts'],
        configure: ['Fee setup', 'Fee heads, late fees, payment gateways and receipt settings'],
      },
      actions: ['view', 'create', 'edit', 'delete', 'approve', 'export', 'configure'],
      grants: {
        // Maker-checker: accountants collect and request; admins approve refunds, discounts and
        // (when enabled) offline receipts.
        'branch-admin': ['view', 'create', 'edit', 'delete', 'approve', 'export'],
        accountant: ['view', 'create', 'edit', 'export'],
      },
    },
    {
      module: 'accounting',
      label: 'Accounting (expenses, bank, P&L)',
      area: 'Finance',
      describe: {
        view: ['View accounts', 'See expenses, bank accounts and profit & loss'],
        create: ['Record expenses', 'Add expenses and bank entries'],
        edit: ['Edit accounts', 'Change expenses and bank entries'],
        delete: ['Delete expenses', 'Remove expenses and bank entries'],
        export: ['Export accounts', 'Download expense, bank and P&L reports'],
      },
      actions: ['view', 'create', 'edit', 'delete', 'export'],
      grants: { 'branch-admin': ['view', 'export'], accountant: 'all' },
    },
    {
      module: 'my-fees',
      label: 'My fees & online payment',
      area: 'My account',
      describe: {
        view: ['Own fees', "See their own (or their children's) fees and receipts"],
        create: ['Pay online', 'Pay fees online'],
      },
      actions: ['view', 'create'],
      grants: { student: ['view', 'create'], parent: ['view', 'create'] },
      selfService: true,
    },
  ],
  jobs: {
    [COURSE_ENROLMENT_JOB]: courseEnrolmentJob,
    [FEES_SWEEP_JOB]: () => runFeesSweep(),
    [FEES_INSTITUTE_SWEEP_JOB]: async () => {
      await runInstituteSweep();
    },
    [FEES_PAYMENT_RECONCILE_JOB]: () => runPaymentReconcile(),
  },
  onReady: async () => {
    registerFeeNotificationEvents();
    registerFeesIntegrations();
    await scheduleFeesSweep();
    await schedulePaymentReconcile();
  },
});
