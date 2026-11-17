/* Scaffolds src/modules/<name>/ with the standard layout. Usage: npm run make:module -- <name> */
import fs from 'node:fs';
import path from 'node:path';

const name = process.argv[2];
if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
  console.error('Usage: npm run make:module -- <kebab-case-name>');
  process.exit(1);
}
const dir = path.resolve(__dirname, '../src/modules', name);
if (fs.existsSync(dir)) {
  console.error(`Module ${name} already exists`);
  process.exit(1);
}
const pascal = name.replace(/(^|-)([a-z0-9])/g, (_m, _d, c: string) => c.toUpperCase());
const camel = pascal[0].toLowerCase() + pascal.slice(1);
const table = name.replace(/-/g, '_');
const ts = new Date().toISOString().replace(/\D/g, '').slice(0, 14);

const files: Record<string, string> = {
  'index.ts': `import { defineModule } from '../../shared/module';
import { ${pascal} } from './${name}.model';
import { ${camel}Routes } from './${name}.routes';

export default defineModule({
  name: '${name}',
  models: (sequelize) => ${pascal}.initModel(sequelize),
  routes: ${camel}Routes,
  permissions: [
    {
      module: '${name}',
      label: '${pascal}',
      actions: ['view', 'create', 'edit', 'delete'],
      grants: { 'branch-admin': 'all' },
    },
  ],
});
`,
  [`${name}.model.ts`]: `import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes, type Sequelize } from 'sequelize';
import { registerTenantModel } from '../../shared/tenancy/tenant-model';

export class ${pascal} extends Model<InferAttributes<${pascal}>, InferCreationAttributes<${pascal}>> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare branchId: number | null;
  declare name: string;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize) {
    ${pascal}.init(
      {
        id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
        instituteId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
        branchId: DataTypes.INTEGER.UNSIGNED,
        name: { type: DataTypes.STRING(150), allowNull: false },
        createdAt: DataTypes.DATE,
        updatedAt: DataTypes.DATE,
      },
      { sequelize, tableName: '${table}' },
    );
    registerTenantModel(${pascal});
  }
}
`,
  [`${name}.routes.ts`]: `import { Router } from 'express';
import { z } from 'zod';
import { parse } from '../../shared/utilities/validation';
import { idParam, paginated, paginationSchema, toLimitOffset } from '../../shared/utilities/pagination';
import { authenticate } from '../../shared/middleware/authenticate';
import { requirePermission } from '../../shared/middleware/authorize';
import { TenantRepository } from '../../shared/tenancy/tenant-repository';
import { audit } from '../../shared/audit/audit.service';
import { ${pascal} } from './${name}.model';

const repo = new TenantRepository(${pascal}, { branchScoped: true, entity: '${pascal}' });
const body = z.object({ name: z.string().trim().min(1).max(150), branchId: z.number().int().positive().nullable().optional() });

export function ${camel}Routes(api: Router) {
  const r = Router();
  r.use(authenticate);

  r.get('/', requirePermission('${name}', 'view'), async (req, res) => {
    const q = parse(paginationSchema, req.query);
    const { rows, count } = await repo.findAndCountAll({ order: [['id', 'DESC']], ...toLimitOffset(q) });
    res.json(paginated(rows, count, q));
  });

  r.post('/', requirePermission('${name}', 'create'), async (req, res) => {
    const data = parse(body, req.body);
    const row = await repo.create({ name: data.name, branchId: data.branchId ?? null });
    await audit({ action: '${name}.created', entityType: '${table}', entityId: row.id });
    res.status(201).json(row);
  });

  r.patch('/:id', requirePermission('${name}', 'edit'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json(await repo.update(id, parse(body.partial(), req.body)));
  });

  r.delete('/:id', requirePermission('${name}', 'delete'), async (req, res) => {
    const { id } = parse(idParam, req.params);
    await repo.destroy(id);
    await audit({ action: '${name}.deleted', entityType: '${table}', entityId: id });
    res.status(204).end();
  });

  api.use('/${name}', r);
}
`,
  [`migrations/${ts}-create-${name}.ts`]: `import { DataTypes } from 'sequelize';
import { id, tenantColumns, timestamps, type Migration } from '../../../infrastructure/database/migration-helpers';

export const up: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.createTable('${table}', {
    id: id(),
    ...tenantColumns({ branch: 'optional' }),
    name: { type: DataTypes.STRING(150), allowNull: false },
    ...timestamps(),
  });
  await queryInterface.addIndex('${table}', ['institute_id', 'branch_id']);
};

export const down: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.dropTable('${table}');
};
`,
};

fs.mkdirSync(path.join(dir, 'migrations'), { recursive: true });
for (const [file, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), content);
console.log(`Created src/modules/${name}/ (${Object.keys(files).join(', ')})`);
console.log('Next: npm run db:migrate, then add app pages in app/src/modules/' + name + '/');
