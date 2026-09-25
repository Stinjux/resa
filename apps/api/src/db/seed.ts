// Données de démonstration : 4 golfs fictifs au Maroc. Les noms, quantités
// et tarifs (hors caddie) sont des valeurs de démonstration À REMPLACER via
// l'écran de configuration. Aucune de ces valeurs n'est lue par le code métier.
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config.js';
import { createPool, withTransaction, type Db } from './pool.js';

export async function seedDemo(db: Db): Promise<void> {
  await withTransaction(db, async (tx) => {
    const existing = await tx.query(`SELECT 1 FROM organizations WHERE code = 'DEMO-MA'`);
    if (existing.rowCount) return;
    const org = await tx.query(
      `INSERT INTO organizations (code, name) VALUES ('DEMO-MA', 'Golfs du Maroc (démo)') RETURNING id`,
    );
    for (const n of [1, 2, 3, 4]) {
      const club = await tx.query(
        `INSERT INTO clubs (organization_id, code, name, timezone, currency, default_locale, country_code)
         VALUES ($1, $2, $3, 'Africa/Casablanca', 'MAD', 'fr', 'MA') RETURNING id`,
        [org.rows[0].id, `G${n}`, `Golf démo ${n}`],
      );
      const clubId = club.rows[0].id;
      await tx.query(`INSERT INTO courses (club_id, code, name) VALUES ($1, 'MAIN', 'Parcours 18 trous')`, [clubId]);
      await tx.query(
        `INSERT INTO schedule_rules (club_id, name, kind, start_time, end_time)
         VALUES ($1, 'Ouverture quotidienne', 'open', '07:00', '17:00')`,
        [clubId],
      );
      await tx.query(
        `INSERT INTO resource_types
           (club_id, code, kind, name, variant, scope, required_per_tee_time, total_quantity,
            price_9_minor, price_18_minor, buffer_minutes, max_per_booking, sort_order)
         VALUES
           ($1, 'CADDIE',        'caddie',     'Caddie',                      NULL,          'tee_time', true,  30, 10000, 20000, 15, NULL, 0),
           ($1, 'CART',          'cart',       'Voiturette',                  NULL,          'booking',  false, 20, 0, 0, 15, 2, 10),
           ($1, 'TROLLEY',       'trolley',    'Chariot',                     NULL,          'booking',  false, 30, 0, 0, 0, 4, 20),
           ($1, 'BAG_MEN_RH',    'rental_bag', 'Sac de location homme droitier',  'men_right',   'booking', false, 6, 0, 0, 0, 4, 30),
           ($1, 'BAG_MEN_LH',    'rental_bag', 'Sac de location homme gaucher',   'men_left',    'booking', false, 2, 0, 0, 0, 4, 31),
           ($1, 'BAG_WOMEN_RH',  'rental_bag', 'Sac de location femme droitière', 'women_right', 'booking', false, 4, 0, 0, 0, 4, 32),
           ($1, 'BAG_WOMEN_LH',  'rental_bag', 'Sac de location femme gauchère',  'women_left',  'booking', false, 2, 0, 0, 0, 4, 33)`,
        [clubId],
      );
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = createPool(loadConfig().databaseUrl);
  seedDemo(db)
    .then(() => console.log('Seed OK'))
    .finally(() => db.end());
}
