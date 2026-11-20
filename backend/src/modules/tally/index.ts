import { defineModule } from '../../shared/module';
import { associateTallyModels, initTallyModels } from './models';
import { tallyRoutes } from './tally.routes';

/** Tally accounting export (TallyPrime / Tally.ERP 9 XML); see docs/integrations/tally.md. */
export default defineModule({
  name: 'tally',
  models: initTallyModels,
  associate: associateTallyModels,
  routes: tallyRoutes,
  permissions: [
    {
      module: 'tally',
      label: 'Tally export (ledger mapping, export files, reconciliation)',
      actions: ['view', 'configure', 'export'],
      grants: { accountant: 'all', 'branch-admin': ['view', 'export'] },
    },
  ],
});
