import { DataTypes } from 'sequelize';
import {
  fk,
  id,
  timestamps,
  tenantColumns,
  type Migration,
} from '../../../infrastructure/database/migration-helpers';

export const up: Migration = async ({ context: { queryInterface } }) => {
  /** One guardian profile per user per institute; the login identity lives in `users`. */
  await queryInterface.createTable('guardians', {
    id: id(),
    ...tenantColumns(),
    user_id: fk('users'),
    name: { type: DataTypes.STRING(150), allowNull: false },
    mobile: { type: DataTypes.STRING(20), allowNull: false },
    email: { type: DataTypes.STRING(150), allowNull: true },
    occupation: { type: DataTypes.STRING(100), allowNull: true },
    address: { type: DataTypes.TEXT, allowNull: true },
    ...timestamps(),
  });
  await queryInterface.addIndex('guardians', ['institute_id', 'user_id'], { unique: true });
  await queryInterface.addIndex('guardians', ['institute_id', 'mobile']);

  await queryInterface.createTable('student_guardians', {
    id: id(),
    ...tenantColumns(),
    student_id: fk('students'),
    guardian_id: fk('guardians'),
    relation: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'guardian' },
    is_primary: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' },
    ...timestamps(),
  });
  await queryInterface.addIndex('student_guardians', ['institute_id', 'student_id', 'guardian_id'], {
    unique: true,
  });
  await queryInterface.addIndex('student_guardians', ['institute_id', 'guardian_id', 'status']);
};

export const down: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.dropTable('student_guardians');
  await queryInterface.dropTable('guardians');
};
