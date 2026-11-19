import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type NonAttribute,
  type Sequelize,
} from 'sequelize';
import type {
  CalendarConnectClient,
  CalendarConnectionStatus,
  CalendarConnectResult,
  CalendarSyncStatus,
} from '@erp/shared';
import { registerTenantModel } from '../../shared/tenancy/tenant-model';
import { User } from '../users/user.model';

const pk = { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true };
const uint = (allowNull = true) => ({ type: DataTypes.INTEGER.UNSIGNED, allowNull });
const str = (len: number, allowNull = true) => ({ type: DataTypes.STRING(len), allowNull });
const date = (allowNull = true) => ({ type: DataTypes.DATE, allowNull });

/** `institute` (the organiser calendar) or `user:<id>` (a teacher's own). One connection per owner. */
export const ownerKeyOf = (userId: number | null) => (userId ? `user:${userId}` : 'institute');

/** A connected Google account. The refresh token is stored encrypted and never leaves the API. */
export class CalendarConnection extends Model<
  InferAttributes<CalendarConnection>,
  InferCreationAttributes<CalendarConnection>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  /** null = the institute's organiser calendar. */
  declare userId: number | null;
  declare ownerKey: string;
  declare provider: CreationOptional<'google'>;
  /** Google account id (`sub`), stable across email changes. */
  declare accountId: string;
  declare accountEmail: string | null;
  declare scopes: string | null;
  declare refreshTokenEncrypted: string;
  declare status: CreationOptional<CalendarConnectionStatus>;
  declare lastError: CreationOptional<string | null>;
  declare connectedByUserId: number | null;
  declare connectedAt: Date;
  declare lastCheckedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
  declare user?: NonAttribute<User | null>;
  declare connectedBy?: NonAttribute<User | null>;

  static initModel(sequelize: Sequelize) {
    CalendarConnection.init(
      {
        id: pk,
        instituteId: uint(false),
        userId: uint(),
        ownerKey: str(40, false),
        provider: { ...str(20, false), defaultValue: 'google' },
        accountId: str(255, false),
        accountEmail: str(255),
        scopes: str(1000),
        refreshTokenEncrypted: { type: DataTypes.TEXT, allowNull: false },
        status: { ...str(20, false), defaultValue: 'active' },
        lastError: str(500),
        connectedByUserId: uint(),
        connectedAt: date(false),
        lastCheckedAt: date(),
        createdAt: DataTypes.DATE,
        updatedAt: DataTypes.DATE,
      },
      { sequelize, tableName: 'calendar_connections' },
    );
    registerTenantModel(CalendarConnection);
  }
}

/**
 * One consent attempt (authorization code flow with PKCE). Only hashes of the `state` and of the
 * browser-binding nonce are stored; the PKCE verifier is encrypted. Single use, 10 minutes.
 */
export class CalendarOAuthState extends Model<
  InferAttributes<CalendarOAuthState>,
  InferCreationAttributes<CalendarOAuthState>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  /** Who started the flow. */
  declare userId: number;
  /** Whose calendar is being connected; null = the institute's organiser calendar. */
  declare ownerUserId: number | null;
  declare stateHash: string;
  declare nonceHash: CreationOptional<string | null>;
  declare codeVerifierEncrypted: string;
  declare client: CalendarConnectClient;
  declare expiresAt: Date;
  declare startedAt: CreationOptional<Date | null>;
  declare usedAt: CreationOptional<Date | null>;
  declare result: CreationOptional<CalendarConnectResult | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize) {
    CalendarOAuthState.init(
      {
        id: pk,
        instituteId: uint(false),
        userId: uint(false),
        ownerUserId: uint(),
        stateHash: { type: DataTypes.CHAR(64), allowNull: false },
        nonceHash: { type: DataTypes.CHAR(64), allowNull: true },
        codeVerifierEncrypted: { type: DataTypes.TEXT, allowNull: false },
        client: str(10, false),
        expiresAt: date(false),
        startedAt: date(),
        usedAt: date(),
        result: str(20),
        createdAt: DataTypes.DATE,
        updatedAt: DataTypes.DATE,
      },
      { sequelize, tableName: 'calendar_oauth_states' },
    );
    registerTenantModel(CalendarOAuthState);
  }
}

/**
 * The calendar event behind one business record (`source` + `sourceId`, e.g. an appointment).
 * `generation` gives a fresh deterministic event id after the previous event was deleted.
 */
export class CalendarEventLink extends Model<
  InferAttributes<CalendarEventLink>,
  InferCreationAttributes<CalendarEventLink>
> {
  declare id: CreationOptional<number>;
  declare instituteId: number;
  declare source: string;
  declare sourceId: number;
  declare connectionId: number | null;
  declare provider: string;
  declare accountId: string | null;
  declare eventId: CreationOptional<string | null>;
  declare generation: CreationOptional<number>;
  declare meetingUrl: CreationOptional<string | null>;
  declare contentHash: CreationOptional<string | null>;
  declare status: CreationOptional<CalendarSyncStatus>;
  /** Consecutive checks for a Meet link that Google is still creating. */
  declare attempts: CreationOptional<number>;
  declare lastError: CreationOptional<string | null>;
  declare syncedAt: CreationOptional<Date | null>;
  /** Short lease so two syncs of the same record never run at once. */
  declare lockedUntil: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  static initModel(sequelize: Sequelize) {
    CalendarEventLink.init(
      {
        id: pk,
        instituteId: uint(false),
        source: str(40, false),
        sourceId: uint(false),
        connectionId: uint(),
        provider: str(20, false),
        accountId: str(255),
        eventId: str(255),
        generation: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
        meetingUrl: str(500),
        contentHash: { type: DataTypes.CHAR(64), allowNull: true },
        status: { ...str(10, false), defaultValue: 'pending' },
        attempts: { type: DataTypes.SMALLINT.UNSIGNED, allowNull: false, defaultValue: 0 },
        lastError: str(500),
        syncedAt: date(),
        lockedUntil: date(),
        createdAt: DataTypes.DATE,
        updatedAt: DataTypes.DATE,
      },
      { sequelize, tableName: 'calendar_events' },
    );
    registerTenantModel(CalendarEventLink);
  }
}

export function initCalendarModels(sequelize: Sequelize) {
  CalendarConnection.initModel(sequelize);
  CalendarOAuthState.initModel(sequelize);
  CalendarEventLink.initModel(sequelize);
}

export function associateCalendarModels() {
  CalendarConnection.belongsTo(User, { as: 'user', foreignKey: 'userId' });
  CalendarConnection.belongsTo(User, { as: 'connectedBy', foreignKey: 'connectedByUserId' });
}
