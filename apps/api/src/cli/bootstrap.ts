// Mise en service : crée l'organisation (si besoin) et un compte
// administrateur du groupe. Le mot de passe est lu dans ADMIN_PASSWORD pour
// ne pas apparaître dans l'historique du terminal.
//
//   ADMIN_PASSWORD='…' npm run bootstrap -w apps/api -- \
//     --org-code GOLFS-MA --org-name "Golfs du Maroc" --email admin@exemple.ma --name "Prénom Nom"
//
// Ensuite : se connecter, Configuration → « Nouveau golf » pour chaque golf.

import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { migrate } from '../db/migrate.js';
import { createPool } from '../db/pool.js';
import { createStaffUser } from '../modules/auth/service.js';

const { values } = parseArgs({
  options: {
    'org-code': { type: 'string' }, 'org-name': { type: 'string' }, email: { type: 'string' }, name: { type: 'string' },
  },
});
const password = process.env.ADMIN_PASSWORD ?? '';
const missing = ['org-code', 'org-name', 'email', 'name'].filter((k) => !values[k as keyof typeof values]);
if (missing.length || password.length < 12) {
  console.error(`Paramètres manquants : ${missing.map((m) => `--${m}`).join(' ') || '—'}.
ADMIN_PASSWORD doit contenir au moins 12 caractères.`);
  process.exit(1);
}

const db = createPool(loadConfig().databaseUrl);
try {
  await migrate(db);
  const org = await db.query(
    `INSERT INTO organizations (code, name) VALUES ($1, $2) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [values['org-code'], values['org-name']],
  );
  const exists = await db.query('SELECT 1 FROM users WHERE organization_id = $1 AND lower(email) = lower($2)', [org.rows[0].id, values.email]);
  if (exists.rowCount) {
    console.error('Un compte existe déjà avec cet e-mail.');
    process.exitCode = 1;
  } else {
    await createStaffUser(db, { organizationId: org.rows[0].id, email: values.email!, password, displayName: values.name!,
      roles: [{ clubId: null, role: 'org_admin' }] });
    console.log(`Administrateur ${values.email} créé pour « ${values['org-name']} ».`);
  }
} finally {
  await db.end();
}
