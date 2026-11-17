import fs from 'node:fs';
import path from 'node:path';
import type { ModuleDefinition } from '../shared/module';

export const MODULES_DIR = path.resolve(__dirname, '../modules');
const EXT = __filename.endsWith('.ts') ? '.ts' : '.js';

let cache: ModuleDefinition[] | null = null;

/** Discovers `src/modules/<name>/index.(ts|js)` in alphabetical order. */
export async function discoverModules(): Promise<ModuleDefinition[]> {
  if (cache) return cache;
  const dirs = fs
    .readdirSync(MODULES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_'))
    .map((d) => d.name)
    .sort();
  const modules: ModuleDefinition[] = [];
  for (const dir of dirs) {
    const entry = path.join(MODULES_DIR, dir, `index${EXT}`);
    if (!fs.existsSync(entry)) continue;
    const mod = await import(entry);
    const def: ModuleDefinition | undefined = mod.default ?? mod.module;
    if (!def?.name) throw new Error(`Module "${dir}" must default-export defineModule({...})`);
    modules.push(def);
  }
  cache = modules;
  return modules;
}
