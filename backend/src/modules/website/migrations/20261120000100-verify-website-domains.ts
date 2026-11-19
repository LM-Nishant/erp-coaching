import { DataTypes } from 'sequelize';
import type { Migration } from '../../../infrastructure/database/migration-helpers';

/**
 * Custom domains are served only once the institute proves ownership with a DNS TXT record. A saved
 * domain is no longer unique (several institutes may enter one); the verified domain is. Domains saved
 * before this migration start unverified, each with its own token.
 */
export const up: Migration = async ({ context: { queryInterface: q } }) => {
  await q.addColumn('website_sites', 'domain_token', { type: DataTypes.STRING(64), allowNull: true });
  await q.addColumn('website_sites', 'verified_domain', { type: DataTypes.STRING(253), allowNull: true });
  await q.addColumn('website_sites', 'domain_verified_at', { type: DataTypes.DATE, allowNull: true });
  await q.addIndex('website_sites', ['verified_domain'], {
    unique: true,
    name: 'website_sites_verified_domain',
  });
  await q.removeIndex('website_sites', 'website_sites_custom_domain');
  await q.sequelize.query(
    'UPDATE website_sites SET domain_token = LOWER(HEX(RANDOM_BYTES(16))) WHERE custom_domain IS NOT NULL',
  );
};

export const down: Migration = async ({ context: { queryInterface: q } }) => {
  // Saved domains must be unique again: unverified duplicates are cleared.
  await q.sequelize.query(
    `UPDATE website_sites s
     JOIN (SELECT custom_domain FROM website_sites WHERE custom_domain IS NOT NULL
           GROUP BY custom_domain HAVING COUNT(*) > 1) d ON d.custom_domain = s.custom_domain
     SET s.custom_domain = NULL
     WHERE s.verified_domain IS NULL OR s.verified_domain <> s.custom_domain`,
  );
  await q.addIndex('website_sites', ['custom_domain'], { unique: true, name: 'website_sites_custom_domain' });
  await q.removeIndex('website_sites', 'website_sites_verified_domain');
  await q.removeColumn('website_sites', 'domain_verified_at');
  await q.removeColumn('website_sites', 'verified_domain');
  await q.removeColumn('website_sites', 'domain_token');
};
