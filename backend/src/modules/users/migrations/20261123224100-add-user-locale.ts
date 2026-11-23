import { DataTypes } from 'sequelize';
import type { Migration } from '../../../infrastructure/database/migration-helpers';

/** The user's app language (`en`/`hi`), saved from the language switch; null = not chosen yet. */
export const up: Migration = async ({ context: { queryInterface: qi } }) => {
  await qi.addColumn('users', 'locale', { type: DataTypes.STRING(5), allowNull: true });
};

export const down: Migration = async ({ context: { queryInterface: qi } }) => {
  await qi.removeColumn('users', 'locale');
};
