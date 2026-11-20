import { defineModule } from '../../shared/module';
import { auditRoutes } from './audit.routes';

/** The AuditEvent model itself is core (src/shared/audit) because every module writes to it. */
export default defineModule({
  name: 'audit',
  routes: auditRoutes,
  permissions: [
    {
      module: 'audit',
      label: 'Audit log',
      area: 'Institute',
      describe: {
        view: ['View audit log', 'See who changed what, and when'],
        export: ['Export audit log', 'Download the audit log'],
      },
      actions: ['view', 'export'],
    },
  ],
});
