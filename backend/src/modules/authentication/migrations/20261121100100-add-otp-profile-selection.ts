import { DataTypes } from 'sequelize';
import type { Migration } from '../../../infrastructure/database/migration-helpers';

/**
 * "Who's signing in?": a verified login OTP for a mobile that several accounts share holds a hashed,
 * single-use selection secret until the person picks a profile (valid for OTP_TTL_SECONDS).
 */
export const up: Migration = async ({ context: { queryInterface: qi } }) => {
  await qi.addColumn('otp_challenges', 'selection_hash', { type: DataTypes.STRING(64), allowNull: true });
  await qi.addColumn('otp_challenges', 'selection_expires_at', { type: DataTypes.DATE, allowNull: true });
};

export const down: Migration = async ({ context: { queryInterface: qi } }) => {
  await qi.removeColumn('otp_challenges', 'selection_expires_at');
  await qi.removeColumn('otp_challenges', 'selection_hash');
};
