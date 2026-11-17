import { DataTypes } from 'sequelize';
import { id, timestamps, fk, type Migration } from '../../../infrastructure/database/migration-helpers';

export const up: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.createTable('institutes', {
    id: id(),
    name: { type: DataTypes.STRING(150), allowNull: false },
    slug: { type: DataTypes.STRING(60), allowNull: false, unique: true },
    status: { type: DataTypes.STRING(20), allowNull: false, defaultValue: 'active' },
    logo_file_id: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    primary_color: { type: DataTypes.STRING(9), allowNull: true },
    secondary_color: { type: DataTypes.STRING(9), allowNull: true },
    address: { type: DataTypes.TEXT, allowNull: true },
    city: { type: DataTypes.STRING(80), allowNull: true },
    state: { type: DataTypes.STRING(80), allowNull: true },
    registration_number: { type: DataTypes.STRING(80), allowNull: true },
    gstin: { type: DataTypes.STRING(20), allowNull: true },
    contact_email: { type: DataTypes.STRING(150), allowNull: true },
    contact_phone: { type: DataTypes.STRING(20), allowNull: true },
    bank_details: { type: DataTypes.JSON, allowNull: true },
    ...timestamps(),
  });
  await queryInterface.createTable('institute_settings', {
    id: id(),
    institute_id: fk('institutes'),
    key: { type: DataTypes.STRING(120), allowNull: false },
    value: { type: DataTypes.JSON, allowNull: true },
    ...timestamps(),
  });
  await queryInterface.addIndex('institute_settings', ['institute_id', 'key'], { unique: true });
};

export const down: Migration = async ({ context: { queryInterface } }) => {
  await queryInterface.dropTable('institute_settings');
  await queryInterface.dropTable('institutes');
};
