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
      area: 'Finance',
      describe: {
        view: ['View Tally export', 'See ledger mapping, past exports and reconciliation'],
        configure: ['Tally setup', 'Map ledgers and set up the Tally export'],
        export: ['Export to Tally', 'Create and download Tally export files'],
      },
      actions: ['view', 'configure', 'export'],
      grants: { accountant: 'all', 'branch-admin': ['view', 'export'] },
    },
  ],
});
