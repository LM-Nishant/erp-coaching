import { DataTypes } from 'sequelize';
import type { Migration } from '../../../infrastructure/database/migration-helpers';

/** The user's app language (`en`/`hi`), saved from the language switch. English unless they pick Hindi. */
export const up: Migration = async ({ context: { queryInterface: qi } }) => {
  await qi.addColumn('users', 'locale', { type: DataTypes.STRING(5), allowNull: false, defaultValue: 'en' });
};

export const down: Migration = async ({ context: { queryInterface: qi } }) => {
  await qi.removeColumn('users', 'locale');
};
