import { QueryTypes, type Attributes, type Model, type ModelStatic } from 'sequelize';
import { decryptSecret, encryptionKeys, encryptSecret, secretKeyId } from '../crypto';

export interface EncryptedColumnsOptions {
  /** Runs after a real (not dry) re-encryption, e.g. to re-key HMACs made with the previous key. */
  afterReencrypt?: () => Promise<void>;
}

interface EncryptedColumnsEntry extends EncryptedColumnsOptions {
  model: ModelStatic<Model>;
  attributes: string[];
}

// Enumerable so `secrets:reencrypt` covers every module's columns.
const ENCRYPTED_COLUMNS = new Map<ModelStatic<Model>, EncryptedColumnsEntry>();

/**
 * Marks attributes that hold `encryptSecret` output, so `secrets:reencrypt` moves them to the current
 * ENCRYPTION_KEY after a rotation. Register every such column next to the model's definition.
 */
export function registerEncryptedColumns<M extends Model>(
  model: ModelStatic<M>,
  attributes: (keyof Attributes<M> & string)[],
  options: EncryptedColumnsOptions = {},
): void {
  ENCRYPTED_COLUMNS.set(model as unknown as ModelStatic<Model>, {
    model: model as unknown as ModelStatic<Model>,
    attributes,
    ...options,
  });
}

export function encryptedColumns(): readonly EncryptedColumnsEntry[] {
  return [...ENCRYPTED_COLUMNS.values()];
}

export interface ReencryptReport {
  table: string;
  column: string;
  /** Non-null values. */
  total: number;
  /** Already encrypted with the current key. */
  current: number;
  /** Moved to the current key (on a dry run: would be). */
  reencrypted: number;
  /** Changed by the application while the command ran (it writes with the current key). */
  changedMeanwhile: number;
  /** Row ids whose value no configured key decrypts. */
  failedIds: number[];
}

const BATCH = 500;

/**
 * Re-encrypts every registered column with the current key. Rows are read in id batches and each
 * update only applies while the stored value is unchanged, so it can run while the API serves traffic.
 * Raw SQL on purpose: no tenant scoping (it is a platform task) and `updatedAt` stays as it was.
 */
export async function reencryptStoredSecrets({ dryRun = false } = {}): Promise<ReencryptReport[]> {
  const { current } = encryptionKeys();
  const reports: ReencryptReport[] = [];
  for (const { model, attributes } of ENCRYPTED_COLUMNS.values()) {
    const sequelize = model.sequelize;
    if (!sequelize) throw new Error(`Model ${model.name} is not initialised`);
    const q = (identifier: string) => sequelize.getQueryInterface().quoteIdentifier(identifier);
    const tableName = model.getTableName();
    const table = typeof tableName === 'string' ? tableName : tableName.tableName;
    const definitions = model.getAttributes();
    const pk = q(definitions[model.primaryKeyAttribute]?.field ?? model.primaryKeyAttribute);
    for (const attribute of attributes) {
      const column = definitions[attribute]?.field ?? attribute;
      const col = q(column);
      const report: ReencryptReport = {
        table,
        column,
        total: 0,
        current: 0,
        reencrypted: 0,
        changedMeanwhile: 0,
        failedIds: [],
      };
      let lastId = 0;
      for (;;) {
        const rows = await sequelize.query<{ id: number; value: string }>(
          `SELECT ${pk} AS id, ${col} AS value FROM ${q(table)}
           WHERE ${pk} > ? AND ${col} IS NOT NULL ORDER BY ${pk} LIMIT ${BATCH}`,
          { replacements: [lastId], type: QueryTypes.SELECT },
        );
        for (const row of rows) {
          lastId = row.id;
          report.total++;
          if (secretKeyId(row.value) === current.id) {
            report.current++;
            continue;
          }
          let plain: string;
          try {
            plain = decryptSecret(row.value);
          } catch {
            report.failedIds.push(row.id);
            continue;
          }
          if (dryRun) {
            report.reencrypted++;
            continue;
          }
          const [, affected] = await sequelize.query(
            `UPDATE ${q(table)} SET ${col} = ? WHERE ${pk} = ? AND ${col} = ?`,
            { replacements: [encryptSecret(plain), row.id, row.value], type: QueryTypes.UPDATE },
          );
          if (affected === 1) report.reencrypted++;
          else report.changedMeanwhile++;
        }
        if (rows.length < BATCH) break;
      }
      reports.push(report);
    }
  }
  if (!dryRun) for (const { afterReencrypt } of ENCRYPTED_COLUMNS.values()) await afterReencrypt?.();
  return reports;
}
