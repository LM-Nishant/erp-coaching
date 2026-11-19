import { DataTypes } from 'sequelize';
import { id, timestamps, fk, type Migration } from '../../../infrastructure/database/migration-helpers';

/**
 * Per-account sign-in lockout: consecutive failed password, OTP and device-unlock attempts. Row
 * `device_id = 0` counts attempts from devices the user has not signed in on; each of the user's own
 * active devices gets its own row, so an attacker's failures never lock the user out of them.
 */
export const up: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.createTable('sign_in_throttles', {
    id: id(),
    user_id: fk('users'),
    device_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    failures: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    locked_until: { type: DataTypes.DATE, allowNull: true },
    last_failure_at: { type: DataTypes.DATE, allowNull: true },
    ...timestamps(),
  });
  await queryInterface.addIndex('sign_in_throttles', ['user_id', 'device_id'], { unique: true });
};

export const down: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.dropTable('sign_in_throttles');
};
