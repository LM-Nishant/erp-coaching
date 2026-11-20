import { DataTypes } from 'sequelize';
import type { Migration } from '../../../infrastructure/database/migration-helpers';

/**
 * Siblings who share a parent's mobile each get their own account. The account that owns the mobile
 * keeps it in `mobile` (still unique); the others have no mobile of their own and record the one they
 * share in `shared_mobile`, where their OTPs and messages go. The code sets exactly one of the two; the
 * constraint only requires one, so the previous release (which never writes `shared_mobile`) still runs.
 */
export const up: Migration = async ({ context: { queryInterface: qi } }) => {
  await qi.sequelize.query('ALTER TABLE users MODIFY mobile VARCHAR(20) NULL');
  await qi.addColumn('users', 'shared_mobile', { type: DataTypes.STRING(20), allowNull: true });
  await qi.addIndex('users', ['shared_mobile']);
  await qi.sequelize.query(
    'ALTER TABLE users ADD CONSTRAINT users_own_or_shared_mobile CHECK (mobile IS NOT NULL OR shared_mobile IS NOT NULL)',
  );
};

export const down: Migration = async ({ context: { queryInterface: qi } }) => {
  const [rows] = await qi.sequelize.query('SELECT COUNT(*) AS n FROM users WHERE mobile IS NULL');
  const shared = Number((rows as { n: number }[])[0].n);
  // Their only link to the mobile they sign in with is `shared_mobile`: keep the schema and roll back the
  // images instead (the previous release runs on it), or restore the pre-upgrade backup.
  if (shared)
    throw new Error(
      `${shared} accounts share another account's mobile and would lose their sign-in; keep this migration`,
    );
  await qi.sequelize.query('ALTER TABLE users DROP CONSTRAINT users_own_or_shared_mobile');
  await qi.removeIndex('users', ['shared_mobile']);
  await qi.removeColumn('users', 'shared_mobile');
  await qi.sequelize.query('ALTER TABLE users MODIFY mobile VARCHAR(20) NOT NULL');
};
