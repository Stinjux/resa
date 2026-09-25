import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://resa:resa@localhost:5432/resa_test';

export default async function setup() {
  const db = createPool(TEST_DATABASE_URL);
  try {
    await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(db);
  } finally {
    await db.end();
  }
}
