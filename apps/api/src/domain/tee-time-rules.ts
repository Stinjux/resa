// Règles d'occupation d'un départ. Fonctions pures, testées unitairement ;
// les services les appliquent sous verrou de ligne sur le départ.

import { DomainError } from '../shared/errors.js';
import { MAX_PLAYERS_PER_TEE_TIME } from './schedule.js';

export type Holes = 9 | 18;

export interface TeeTimeState {
  maxPlayers: number;
  holes: Holes | null;
  isPrivate: boolean;
  bookedPlayers: number; // joueurs des réservations confirmées
}

export interface JoinRequest {
  players: number;
  holes: Holes;
  isPrivate: boolean;
}

export function capacityOf(state: Pick<TeeTimeState, 'maxPlayers'>): number {
  return Math.min(state.maxPlayers, MAX_PLAYERS_PER_TEE_TIME);
}

/** Places encore proposables à d'autres clients (0 si le départ est privé). */
export function remainingSeats(state: TeeTimeState): number {
  if (state.isPrivate && state.bookedPlayers > 0) return 0;
  return Math.max(0, capacityOf(state) - state.bookedPlayers);
}

export function assertValidPlayers(players: number): void {
  if (!Number.isInteger(players) || players < 1 || players > MAX_PLAYERS_PER_TEE_TIME) {
    throw new DomainError('VALIDATION', `Nombre de joueurs invalide : ${players} (1 à ${MAX_PLAYERS_PER_TEE_TIME}).`);
  }
}

/** Vérifie qu'une réservation peut rejoindre le départ ; lève sinon. */
export function assertCanJoin(state: TeeTimeState, req: JoinRequest): void {
  assertValidPlayers(req.players);
  const occupied = state.bookedPlayers > 0;

  if (occupied && state.isPrivate) {
    throw new DomainError('TEE_TIME_PRIVATE', 'Ce départ est privatisé.');
  }
  if (occupied && req.isPrivate) {
    throw new DomainError(
      'PRIVATE_REQUIRES_EMPTY_TEE_TIME',
      'Un départ privé ne peut être réservé que sur un départ encore vide.',
    );
  }
  if (occupied && state.holes !== null && state.holes !== req.holes) {
    throw new DomainError('HOLES_MISMATCH', `Ce départ est déjà réservé en ${state.holes} trous.`, {
      teeTimeHoles: state.holes,
    });
  }
  const remaining = capacityOf(state) - state.bookedPlayers;
  if (req.players > remaining) {
    throw new DomainError('TEE_TIME_FULL', `Places restantes insuffisantes (${Math.max(0, remaining)}).`, {
      remaining: Math.max(0, remaining),
    });
  }
}

/** État du départ après ajout de la réservation (à utiliser après assertCanJoin). */
export function applyJoin(state: TeeTimeState, req: JoinRequest): TeeTimeState {
  return {
    ...state,
    bookedPlayers: state.bookedPlayers + req.players,
    holes: req.holes,
    isPrivate: state.isPrivate || req.isPrivate,
  };
}
