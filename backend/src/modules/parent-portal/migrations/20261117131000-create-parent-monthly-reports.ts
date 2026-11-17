import { DataTypes } from 'sequelize';
import {
  fk,
  id,
  tenantColumns,
  timestamps,
  type Migration,
} from '../../../infrastructure/database/migration-helpers';

export const up: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.createTable('parent_monthly_reports', {
    id: id(),
    ...tenantColumns({ branch: 'required' }),
    student_id: fk('students'),
    period: { type: DataTypes.CHAR(7), allowNull: false },
    sections: { type: DataTypes.JSON, allowNull: false },
    generated_at: { type: DataTypes.DATE, allowNull: false },
    ...timestamps(),
  });
  await queryInterface.addIndex('parent_monthly_reports', ['institute_id', 'student_id', 'period'], {
    unique: true,
    name: 'parent_monthly_reports_student_period',
  });
  await queryInterface.addIndex('parent_monthly_reports', ['institute_id', 'period']);
};

export const down: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.dropTable('parent_monthly_reports');
};
