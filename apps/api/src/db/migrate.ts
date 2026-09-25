import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPool, withTransaction, type Db } from './pool.js';
import { loadConfig } from '../config.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate(db: Db): Promise<string[]> {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const file of files) {
    await withTransaction(db, async (tx) => {
      // Un seul migrateur à la fois.
      await tx.query('SELECT pg_advisory_xact_lock(424242)');
      const done = await tx.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (done.rowCount) return;
      await tx.query(await readFile(path.join(MIGRATIONS_DIR, file), 'utf8'));
      await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      applied.push(file);
    });
  }
  return applied;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = createPool(loadConfig().databaseUrl);
  migrate(db)
    .then((applied) => console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Up to date'))
    .finally(() => db.end());
}
