import { Sequelize } from 'sequelize';
import { config } from '../config';
import { logger } from '../logger';

let instance: Sequelize | null = null;

export function getSequelize(): Sequelize {
  if (!instance) {
    instance = new Sequelize(config.DB_NAME, config.DB_USER, config.DB_PASSWORD, {
      host: config.DB_HOST,
      port: config.DB_PORT,
      dialect: 'mysql',
      timezone: '+00:00',
      logging: config.DB_LOGGING ? (sql) => logger.debug(sql) : false,
      define: { underscored: true, timestamps: true },
      pool: { max: 10, min: 0, idle: 10000 },
    });
  }
  return instance;
}

export async function closeSequelize(): Promise<void> {
  if (instance) {
    await instance.close();
    instance = null;
  }
}
