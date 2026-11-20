import type { Server } from 'node:http';
import type { Router } from 'express';
import type { Sequelize } from 'sequelize';
import type { PermissionAction, SystemRoleSlug } from '@erp/shared';
import type { JobHandler } from '../infrastructure/jobs/queue';

export interface PermissionDeclaration {
  /** Permission module key, e.g. `branches`. Keys become `<module>.<action>`. */
  module: string;
  label: string;
  actions: readonly PermissionAction[];
  /** Default grants for system roles; synced on every boot. */
  grants?: Partial<Record<SystemRoleSlug, readonly PermissionAction[] | 'all'>>;
  /**
   * Self-service actions (`true` = all): the user acts on their own records or their linked
   * children's, e.g. a student's fees. Institute Admin's every-permission default skips them so
   * staff menus hold no persona pages; grant them explicitly (`grants` or a custom role) instead.
   */
  selfService?: true | readonly PermissionAction[];
}

/**
 * Every folder in `src/modules/<name>/` exports `default defineModule({...})` from `index.ts`.
 * The loader discovers modules automatically; no shared file needs editing to add one.
 */
export interface ModuleDefinition {
  name: string;
  /** Call `Model.init(...)` for each model owned by the module. */
  models?: (sequelize: Sequelize) => void;
  /** Define associations; runs after every module's models are initialised. */
  associate?: () => void;
  /** Register routes. The router is mounted at `/api`. */
  routes?: (router: Router) => void;
  permissions?: PermissionDeclaration[];
  /** Background job handlers keyed by job name (prefix with module name, e.g. `files.cleanup`). */
  jobs?: Record<string, JobHandler>;
  /** Runs once after DB connection and associations are ready. */
  onReady?: () => Promise<void> | void;
  /**
   * API process only: runs once the HTTP server exists, e.g. to attach a Socket.IO/WebSocket server.
   * Use a module-prefixed path (`/api/<module>/…`) and authenticate every connection.
   */
  attachServer?: (server: Server) => void;
}

export function defineModule(def: ModuleDefinition): ModuleDefinition {
  return def;
}
