/** Erreur métier : règle de réservation violée. Code stable, exploitable par
 *  les interfaces (traduction) et par l'API (HTTP 409/422/404). */
export type DomainErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'SLOT_NOT_AVAILABLE'
  | 'TEE_TIME_FULL'
  | 'TEE_TIME_PRIVATE'
  | 'PRIVATE_REQUIRES_EMPTY_TEE_TIME'
  | 'HOLES_MISMATCH'
  | 'HOLES_NOT_ALLOWED'
  | 'CADDIE_UNAVAILABLE'
  | 'RESOURCE_UNAVAILABLE'
  | 'BOOKING_CANCELLED'
  | 'OUTSIDE_BOOKING_WINDOW'
  | 'PRICE_NOT_CONFIGURED'
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'FORBIDDEN'
  | 'EMAIL_TAKEN'
  | 'NO_CADDIE_RESERVED'
  | 'CADDIE_ALREADY_ASSIGNED'
  | 'UNIT_UNAVAILABLE'
  | 'AI_NOT_CONFIGURED'
  | 'AI_UNAVAILABLE'
  | 'DRAFT_EXPIRED'
  | 'TEE_TIME_BLOCKED';

export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
