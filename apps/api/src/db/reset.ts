// Réinitialise la base de DÉVELOPPEMENT : efface tout, migre, recharge la démo.
import { loadConfig } from '../config.js';
import { migrate } from './migrate.js';
import { createPool } from './pool.js';
import { seedDemo } from './seed.js';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusé : NODE_ENV=production.');
  process.exit(1);
}
const db = createPool(loadConfig().databaseUrl);
try {
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db);
  await seedDemo(db);
  console.log('Base de développement réinitialisée avec les données de démo.');
} finally {
  await db.end();
}
