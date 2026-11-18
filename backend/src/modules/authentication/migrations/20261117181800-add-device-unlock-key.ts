import { DataTypes } from 'sequelize';
import type { Migration } from '../../../infrastructure/database/migration-helpers';

/**
 * Biometric unlock (spec 4.18): SHA-256 of the per-device secret the app keeps in secure storage
 * behind the OS biometric prompt. Cleared when the device is revoked or the user turns it off.
 */
export const up: Migration = async ({ context: { queryInterface: qi } }) => {
  await qi.addColumn('devices', 'unlock_key_hash', { type: DataTypes.STRING(64), allowNull: true });
  await qi.addColumn('devices', 'unlock_enrolled_at', { type: DataTypes.DATE, allowNull: true });
};

export const down: Migration = async ({ context: { queryInterface: qi } }) => {
  await qi.removeColumn('devices', 'unlock_enrolled_at');
  await qi.removeColumn('devices', 'unlock_key_hash');
};
