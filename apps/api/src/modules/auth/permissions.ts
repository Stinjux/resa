// Rôles et permissions. Un rôle du personnel est rattaché à UN golf, sauf
// org_admin qui couvre tous les golfs de son organisation.

import { DateTime } from 'luxon';
import { DomainError } from '../../shared/errors.js';

export type Role = 'org_admin' | 'club_admin' | 'receptionist' | 'starter';

export type Permission =
  | 'teesheet.view' // voir la feuille de départs
  | 'booking.view'
  | 'booking.manage' // créer (téléphone, groupe), modifier, déplacer, réunir, annuler
  | 'customer.view' // coordonnées et fiche des golfeurs du golf
  | 'starter.operate' // attribuer caddie et matériel
  | 'config.manage'
  | 'audit.view'
  | 'reports.view'; // statistiques et rapports IA

const ALL: Permission[] = [
  'teesheet.view', 'booking.view', 'booking.manage', 'customer.view', 'starter.operate', 'config.manage', 'audit.view',
  'reports.view',
];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  org_admin: ALL,
  club_admin: ALL,
  receptionist: ['teesheet.view', 'booking.view', 'booking.manage', 'customer.view'],
  starter: ['teesheet.view', 'booking.view', 'starter.operate'],
};

/** Le starter ne voit que le jour même et les 6 jours suivants. */
export const STARTER_WINDOW_DAYS = 7;

export interface Principal {
  userId: string;
  organizationId: string;
  displayName: string;
  customerId: string | null;
  roles: Array<{ clubId: string | null; role: Role }>;
}

export interface ClubRef {
  id: string;
  organizationId: string;
  timezone: string;
}

export function rolesFor(p: Principal | null, club: ClubRef): Role[] {
  if (!p || p.organizationId !== club.organizationId) return [];
  return p.roles.filter((r) => r.clubId === club.id || (r.clubId === null && r.role === 'org_admin')).map((r) => r.role);
}

export function can(p: Principal | null, perm: Permission, club: ClubRef): boolean {
  return rolesFor(p, club).some((r) => ROLE_PERMISSIONS[r].includes(perm));
}

export function assertCan(p: Principal | null, perm: Permission, club: ClubRef): void {
  if (!p) throw new DomainError('UNAUTHENTICATED', 'Connexion requise.');
  if (!can(p, perm, club)) throw new DomainError('FORBIDDEN', 'Accès refusé pour ce golf.');
}

export function isStaff(p: Principal | null): boolean {
  return !!p && p.roles.length > 0;
}

/**
 * Plage de dates consultable. null = sans limite. Seul le starter (sans autre
 * rôle donnant la feuille de départs) est limité à la semaine en cours.
 */
export function visibleDateRange(p: Principal | null, club: ClubRef, now: Date): { from: string; to: string } | null {
  const roles = rolesFor(p, club);
  const unrestricted = roles.some((r) => r !== 'starter' && ROLE_PERMISSIONS[r].includes('teesheet.view'));
  if (unrestricted) return null;
  const today = DateTime.fromJSDate(now, { zone: club.timezone }).startOf('day');
  return { from: today.toISODate()!, to: today.plus({ days: STARTER_WINDOW_DAYS - 1 }).toISODate()! };
}

export function assertDateVisible(p: Principal | null, club: ClubRef, date: string, now: Date): void {
  const range = visibleDateRange(p, club, now);
  if (range && (date < range.from || date > range.to)) {
    throw new DomainError('FORBIDDEN', `Consultation limitée du ${range.from} au ${range.to}.`, range);
  }
}
