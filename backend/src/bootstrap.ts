import { getSequelize } from './infrastructure/database/sequelize';
import { discoverModules } from './infrastructure/module-loader';
import { registerJobHandler } from './infrastructure/jobs/queue';
import { Job } from './infrastructure/jobs/job.model';
import { AuditEvent } from './shared/audit/audit-event.model';
import type { ModuleDefinition } from './shared/module';
import { logger } from './infrastructure/logger';

let modelsReady: Promise<ModuleDefinition[]> | null = null;

/** Initialise core + module models and associations (idempotent). Used by the API, CLI and tests. */
export function initModels(): Promise<ModuleDefinition[]> {
  modelsReady ??= (async () => {
    const sequelize = getSequelize();
    AuditEvent.initModel(sequelize);
    Job.initModel(sequelize);
    const modules = await discoverModules();
    for (const m of modules) m.models?.(sequelize);
    for (const m of modules) m.associate?.();
    return modules;
  })();
  return modelsReady;
}

/** Full boot: models, permission catalog sync, job handlers and module onReady hooks. */
export async function bootstrap(): Promise<ModuleDefinition[]> {
  const modules = await initModels();
  await getSequelize().authenticate();
  const { syncPermissionCatalog } = await import('./modules/permissions/catalog.service');
  await syncPermissionCatalog(modules);
  for (const m of modules) {
    for (const [name, handler] of Object.entries(m.jobs ?? {})) registerJobHandler(name, handler);
  }
  for (const m of modules) await m.onReady?.();
  logger.info({ modules: modules.map((m) => m.name) }, 'modules loaded');
  return modules;
}
