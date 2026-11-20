import { DataTypes } from 'sequelize';
import type { Migration } from '../../../infrastructure/database/migration-helpers';

/** Set when the teacher supplied their own meeting link (no Google Meet is created for it). */
export const up: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.addColumn('appointments', 'meeting_url_custom', {
    type: DataTypes.BOOLEAN,
    allowNull: false,
    defaultValue: false,
  });
};

export const down: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.removeColumn('appointments', 'meeting_url_custom');
};
