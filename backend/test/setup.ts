import { afterAll } from 'vitest';
import { closeSequelize } from '../src/infrastructure/database/sequelize';

afterAll(async () => {
  await closeSequelize();
});
