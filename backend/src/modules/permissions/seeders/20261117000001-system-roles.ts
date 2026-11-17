import type { Migration } from '../../../infrastructure/database/migration-helpers';
import { discoverModules } from '../../../infrastructure/module-loader';
import { syncPermissionCatalog } from '../catalog.service';

/** Permission catalog + system roles (also re-synced on every API boot). */
export const up: Migration = async () => {
  await syncPermissionCatalog(await discoverModules());
};

export const down: Migration = async () => {};
