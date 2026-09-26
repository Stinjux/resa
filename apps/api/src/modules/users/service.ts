// Comptes du personnel : création, rôles par golf, désactivation,
// réinitialisation du mot de passe. Chaque action est historisée.
//
// - L'administrateur du groupe (org_admin) gère tous les comptes.
// - La direction d'un golf (club_admin) gère les comptes rattachés
//   uniquement à ses golfs, et ne donne que des rôles sur ses golfs.
// - Personne ne peut se désactiver ni retirer ses propres droits
//   d'administration (évite de se bloquer dehors).

import { createHash, randomBytes } from 'node:crypto';
import type { Db, Queryable } from '../../db/pool.js';
import { withTransaction } from '../../db/pool.js';
import { audit, type Actor } from '../../shared/audit.js';
import { DomainError } from '../../shared/errors.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import type { Principal, Role } from '../auth/permissions.js';

export interface RoleGrant { clubId: string | null; role: Role }

export const MIN_PASSWORD = 10;

/** Golfs que l'appelant administre ; null = tous (org_admin). */
function managedClubs(p: Principal): Set<string> | null {
  if (p.roles.some((r) => r.role === 'org_admin' && r.clubId === null)) return null;
  const clubs = new Set(p.roles.filter((r) => r.role === 'club_admin' && r.clubId).map((r) => r.clubId!));
  if (!clubs.size) throw new DomainError('FORBIDDEN', 'Réservé à la direction.');
  return clubs;
}

function canGrant(scope: Set<string> | null, g: RoleGrant): boolean {
  if (scope === null) return true;
  return g.role !== 'org_admin' && g.clubId !== null && scope.has(g.clubId);
}

async function loadTarget(q: Queryable, p: Principal, userId: string) {
  const { rows } = await q.query(
    `SELECT u.id, u.email, u.active, u.customer_id AS "customerId", u.partner_id AS "partnerId",
            coalesce(json_agg(json_build_object('clubId', r.club_id, 'role', r.role)) FILTER (WHERE r.id IS NOT NULL), '[]') AS roles
       FROM users u LEFT JOIN user_roles r ON r.user_id = u.id
      WHERE u.id = $1 AND u.organization_id = $2 GROUP BY u.id`,
    [userId, p.organizationId],
  );
  const u = rows[0];
  if (!u || u.customerId || u.partnerId) throw new DomainError('NOT_FOUND', 'Compte introuvable.');
  const scope = managedClubs(p);
  // Un directeur ne touche qu'aux comptes entièrement rattachés à ses golfs.
  if (scope && !(u.roles as RoleGrant[]).every((g) => canGrant(scope, g))) {
    throw new DomainError('FORBIDDEN', 'Ce compte a des droits sur d’autres golfs : demandez à l’administrateur du groupe.');
  }
  return { ...u, roles: u.roles as RoleGrant[], scope };
}

async function validateRoles(q: Queryable, p: Principal, scope: Set<string> | null, roles: RoleGrant[]) {
  if (!roles.length) throw new DomainError('VALIDATION', 'Au moins un rôle.');
  for (const g of roles) {
    if (g.role === 'org_admin' ? g.clubId !== null : g.clubId === null) {
      throw new DomainError('VALIDATION', 'Rôle invalide : administrateur du groupe sans golf, autres rôles sur un golf.');
    }
    if (!canGrant(scope, g)) throw new DomainError('FORBIDDEN', 'Vous ne pouvez donner des droits que sur vos golfs.');
  }
  const clubIds = [...new Set(roles.map((g) => g.clubId).filter(Boolean))];
  const { rows } = await q.query('SELECT count(*)::int AS n FROM clubs WHERE id = ANY($1) AND organization_id = $2', [clubIds, p.organizationId]);
  if (rows[0].n !== clubIds.length) throw new DomainError('VALIDATION', 'Golf inconnu.');
}

export async function listStaff(q: Queryable, p: Principal) {
  const scope = managedClubs(p);
  const { rows } = await q.query(
    `SELECT u.id, u.email, u.display_name AS "displayName", u.active, u.must_change_password AS "mustChangePassword",
            u.last_login_at AS "lastLoginAt", u.created_at AS "createdAt",
            coalesce(json_agg(json_build_object('clubId', r.club_id, 'role', r.role) ORDER BY r.role) FILTER (WHERE r.id IS NOT NULL), '[]') AS roles
       FROM users u LEFT JOIN user_roles r ON r.user_id = u.id
      WHERE u.organization_id = $1 AND u.customer_id IS NULL AND u.partner_id IS NULL
      GROUP BY u.id ORDER BY u.active DESC, u.display_name`,
    [p.organizationId],
  );
  return rows
    // Un directeur voit les comptes qui ont au moins un rôle sur ses golfs.
    .filter((u) => scope === null || (u.roles as RoleGrant[]).some((g) => g.clubId && scope.has(g.clubId)))
    .map((u) => ({ ...u, editable: scope === null || (u.roles as RoleGrant[]).every((g) => canGrant(scope, g)) }));
}

const tempPassword = () => randomBytes(9).toString('base64url'); // 12 caractères

export async function createStaff(db: Db, p: Principal, input: { email: string; displayName: string; roles: RoleGrant[] }, actor: Actor) {
  const scope = managedClubs(p);
  await validateRoles(db, p, scope, input.roles);
  const password = tempPassword();
  const hash = await hashPassword(password);
  const id = await withTransaction(db, async (tx) => {
    const taken = await tx.query('SELECT 1 FROM users WHERE organization_id = $1 AND lower(email) = lower($2)', [p.organizationId, input.email]);
    if (taken.rowCount) throw new DomainError('EMAIL_TAKEN', 'Un compte existe déjà avec cet e-mail.');
    const { rows } = await tx.query(
      `INSERT INTO users (organization_id, email, password_hash, display_name, must_change_password) VALUES ($1, $2, $3, $4, true) RETURNING id`,
      [p.organizationId, input.email.trim(), hash, input.displayName.trim()],
    );
    for (const g of input.roles) await tx.query('INSERT INTO user_roles (user_id, club_id, role) VALUES ($1, $2, $3)', [rows[0].id, g.clubId, g.role]);
    await audit(tx, { clubId: null, actor, action: 'user.created', entityType: 'user', entityId: rows[0].id, data: { roles: input.roles } });
    return rows[0].id as string;
  });
  // Mot de passe provisoire : affiché une seule fois, à changer à la première connexion.
  return { id, temporaryPassword: password };
}

export async function updateStaff(db: Db, p: Principal, userId: string, input: { displayName?: string; roles?: RoleGrant[]; active?: boolean }, actor: Actor) {
  await withTransaction(db, async (tx) => {
    const target = await loadTarget(tx, p, userId);
    const self = userId === p.userId;
    if (self && input.active === false) throw new DomainError('VALIDATION', 'Vous ne pouvez pas désactiver votre propre compte.');
    if (input.roles) {
      await validateRoles(tx, p, target.scope, input.roles);
      if (self) {
        const admin = (gs: RoleGrant[]) => gs.some((g) => g.role === 'org_admin' || g.role === 'club_admin');
        if (admin(target.roles) && !admin(input.roles)) throw new DomainError('VALIDATION', 'Vous ne pouvez pas retirer vos propres droits d’administration.');
      }
      await tx.query('DELETE FROM user_roles WHERE user_id = $1', [userId]);
      for (const g of input.roles) await tx.query('INSERT INTO user_roles (user_id, club_id, role) VALUES ($1, $2, $3)', [userId, g.clubId, g.role]);
    }
    if (input.displayName !== undefined) await tx.query('UPDATE users SET display_name = $2 WHERE id = $1', [userId, input.displayName.trim()]);
    if (input.active !== undefined) {
      await tx.query('UPDATE users SET active = $2 WHERE id = $1', [userId, input.active]);
      if (!input.active) await tx.query('DELETE FROM sessions WHERE user_id = $1', [userId]); // déconnexion immédiate
    }
    await audit(tx, { clubId: null, actor, action: 'user.updated', entityType: 'user', entityId: userId,
      data: { roles: input.roles, active: input.active, renamed: input.displayName !== undefined } });
  });
}

/** Nouveau mot de passe provisoire, à changer à la prochaine connexion ; sessions fermées. */
export async function resetStaffPassword(db: Db, p: Principal, userId: string, actor: Actor) {
  const password = tempPassword();
  const hash = await hashPassword(password);
  await withTransaction(db, async (tx) => {
    await loadTarget(tx, p, userId);
    await tx.query('UPDATE users SET password_hash = $2, must_change_password = true WHERE id = $1', [userId, hash]);
    await tx.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
    await audit(tx, { clubId: null, actor, action: 'user.password_reset', entityType: 'user', entityId: userId });
  });
  return { temporaryPassword: password };
}

/** Changement de son propre mot de passe (tout compte). Les autres sessions sont fermées. */
export async function changeOwnPassword(db: Db, userId: string, currentToken: string | null, input: { current: string; next: string }) {
  if (input.next.length < MIN_PASSWORD) throw new DomainError('VALIDATION', `Mot de passe : ${MIN_PASSWORD} caractères minimum.`);
  if (input.next === input.current) throw new DomainError('VALIDATION', 'Le nouveau mot de passe doit être différent de l’ancien.');
  const { rows } = await db.query('SELECT password_hash AS hash FROM users WHERE id = $1', [userId]);
  if (!rows[0] || !(await verifyPassword(input.current, rows[0].hash))) throw new DomainError('INVALID_CREDENTIALS', 'Mot de passe actuel incorrect.');
  const hash = await hashPassword(input.next);
  const keep = currentToken ? createHash('sha256').update(currentToken).digest('hex') : '';
  await withTransaction(db, async (tx) => {
    await tx.query('UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1', [userId, hash]);
    await tx.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [userId, keep]);
    await audit(tx, { clubId: null, actor: { type: 'user', id: userId }, action: 'user.password_changed', entityType: 'user', entityId: userId });
  });
}
