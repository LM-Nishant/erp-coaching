import { DataTypes } from 'sequelize';
import { id, timestamps, fk, tenantColumns, type Migration } from '../../../infrastructure/database/migration-helpers';

export const up: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.createTable('permissions', {
    id: id(),
    module: { type: DataTypes.STRING(60), allowNull: false },
    action: { type: DataTypes.STRING(20), allowNull: false },
    key: { type: DataTypes.STRING(90), allowNull: false, unique: true },
    label: { type: DataTypes.STRING(120), allowNull: false },
  });
  await queryInterface.createTable('roles', {
    id: id(),
    institute_id: fk('institutes', { allowNull: true, onDelete: 'CASCADE' }),
    slug: { type: DataTypes.STRING(60), allowNull: false },
    name: { type: DataTypes.STRING(100), allowNull: false },
    description: { type: DataTypes.STRING(255), allowNull: true },
    is_system: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    ...timestamps(),
  });
  await queryInterface.addIndex('roles', ['institute_id', 'slug'], { unique: true });
  await queryInterface.createTable('role_permissions', {
    role_id: { ...fk('roles'), primaryKey: true },
    permission_id: { ...fk('permissions'), primaryKey: true },
  });
  await queryInterface.createTable('user_roles', {
    id: id(),
    user_id: fk('users'),
    role_id: fk('roles'),
    ...tenantColumns({ branch: 'optional' }),
    ...timestamps(),
  });
  await queryInterface.addIndex('user_roles', ['institute_id', 'user_id']);
  await queryInterface.createTable('user_branches', {
    id: id(),
    user_id: fk('users'),
    ...tenantColumns({ branch: 'required' }),
    ...timestamps(),
  });
  await queryInterface.addIndex('user_branches', ['user_id', 'branch_id'], { unique: true });
};

export const down: Migration = async ({ context: { queryInterface } }) => {
  for (const t of ['user_branches', 'user_roles', 'role_permissions', 'roles', 'permissions']) {
    await queryInterface.dropTable(t);
  }
};
