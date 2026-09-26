import { createHash, randomBytes } from 'node:crypto';
import type { Db, Queryable } from '../../db/pool.js';
import { withTransaction } from '../../db/pool.js';
import { DomainError } from '../../shared/errors.js';
import { hashPassword, verifyPassword } from './password.js';
import type { Principal, Role } from './permissions.js';

const SESSION_HOURS = 12;
let dummyHash: Promise<string> | null = null;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function login(
  db: Db,
  input: { email: string; password: string; organizationCode?: string },
  now: Date,
): Promise<{ token: string; expiresAt: Date; principal: Principal }> {
  const { rows } = await db.query(
    `SELECT u.id, u.password_hash AS "passwordHash"
       FROM users u JOIN organizations o ON o.id = u.organization_id
      WHERE lower(u.email) = lower($1) AND u.active AND ($2::text IS NULL OR o.code = $2)`,
    [input.email, input.organizationCode ?? null],
  );
  // Même message et même coût de calcul que le compte existe ou non.
  const user = rows.length === 1 ? rows[0] : null;
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  const ok = await verifyPassword(input.password, user?.passwordHash ?? (await dummyHash));
  if (!user || !ok) throw new DomainError('INVALID_CREDENTIALS', 'Identifiants invalides.');

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_HOURS * 3_600_000);
  await db.query('INSERT INTO sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)', [
    user.id,
    hashToken(token),
    expiresAt,
  ]);
  await db.query('UPDATE users SET last_login_at = $2 WHERE id = $1', [user.id, now]);
  return { token, expiresAt, principal: (await loadPrincipal(db, user.id))! };
}

export async function logout(db: Db, token: string): Promise<void> {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

export async function loadPrincipal(q: Queryable, userId: string): Promise<Principal | null> {
  const { rows } = await q.query(
    `SELECT u.id, u.organization_id AS "organizationId", u.display_name AS "displayName", u.customer_id AS "customerId",
            u.partner_id AS "partnerId", p.name AS "partnerName", u.must_change_password AS "mustChangePassword"
       FROM users u LEFT JOIN partners p ON p.id = u.partner_id
      WHERE u.id = $1 AND u.active AND (u.partner_id IS NULL OR p.active)`,
    [userId],
  );
  if (!rows[0]) return null;
  const roles = await q.query<{ clubId: string | null; role: Role }>(
    'SELECT club_id AS "clubId", role FROM user_roles WHERE user_id = $1',
    [userId],
  );
  return { userId: rows[0].id, organizationId: rows[0].organizationId, displayName: rows[0].displayName,
    customerId: rows[0].customerId, partnerId: rows[0].partnerId, partnerName: rows[0].partnerName,
    mustChangePassword: rows[0].mustChangePassword, roles: roles.rows };
}

export async function principalFromToken(q: Queryable, token: string, now: Date): Promise<Principal | null> {
  const { rows } = await q.query('SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > $2', [
    hashToken(token),
    now,
  ]);
  return rows[0] ? loadPrincipal(q, rows[0].user_id) : null;
}

/** Création d'un compte client (parcours web). */
export async function registerCustomer(
  db: Db,
  input: { organizationId: string; email: string; password: string; firstName?: string | null; lastName: string; phone?: string | null },
): Promise<string> {
  if (input.password.length < 8) throw new DomainError('VALIDATION', 'Mot de passe : 8 caractères minimum.');
  const passwordHash = await hashPassword(input.password);
  return withTransaction(db, async (tx) => {
    const taken = await tx.query('SELECT 1 FROM users WHERE organization_id = $1 AND lower(email) = lower($2)', [
      input.organizationId,
      input.email,
    ]);
    if (taken.rowCount) throw new DomainError('EMAIL_TAKEN', 'Un compte existe déjà avec cet e-mail.');
    const c = await tx.query(
      `INSERT INTO customers (organization_id, first_name, last_name, email, phone) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [input.organizationId, input.firstName ?? null, input.lastName, input.email, input.phone ?? null],
    );
    const u = await tx.query(
      `INSERT INTO users (organization_id, email, password_hash, display_name, customer_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [input.organizationId, input.email, passwordHash, [input.firstName, input.lastName].filter(Boolean).join(' '), c.rows[0].id],
    );
    return u.rows[0].id;
  });
}

/** Création d'un compte du personnel (utilisé par le seed et, plus tard, l'écran d'administration). */
export async function createStaffUser(
  db: Queryable,
  input: { organizationId: string; email: string; password: string; displayName: string; roles: Array<{ clubId: string | null; role: Role }> },
): Promise<string> {
  const u = await db.query(
    `INSERT INTO users (organization_id, email, password_hash, display_name) VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.organizationId, input.email, await hashPassword(input.password), input.displayName],
  );
  for (const r of input.roles) {
    await db.query('INSERT INTO user_roles (user_id, club_id, role) VALUES ($1, $2, $3)', [u.rows[0].id, r.clubId, r.role]);
  }
  return u.rows[0].id;
}
