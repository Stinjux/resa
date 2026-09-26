import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';
import { DomainError, type DomainErrorCode } from '../shared/errors.js';

const STATUS: Record<DomainErrorCode, number> = {
  NOT_FOUND: 404,
  VALIDATION: 422,
  HOLES_NOT_ALLOWED: 422,
  OUTSIDE_BOOKING_WINDOW: 422,
  SLOT_NOT_AVAILABLE: 409,
  TEE_TIME_FULL: 409,
  TEE_TIME_PRIVATE: 409,
  PRIVATE_REQUIRES_EMPTY_TEE_TIME: 409,
  HOLES_MISMATCH: 409,
  CADDIE_UNAVAILABLE: 409,
  RESOURCE_UNAVAILABLE: 409,
  BOOKING_CANCELLED: 409,
  PRICE_NOT_CONFIGURED: 422,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  EMAIL_TAKEN: 409,
  NO_CADDIE_RESERVED: 409,
  CADDIE_ALREADY_ASSIGNED: 409,
  UNIT_UNAVAILABLE: 409,
  AI_NOT_CONFIGURED: 503,
  AI_UNAVAILABLE: 502,
  DRAFT_EXPIRED: 409,
};

export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof DomainError) {
    return reply.status(STATUS[err.code]).send({ error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err instanceof ZodError) {
    return reply
      .status(422)
      .send({ error: { code: 'VALIDATION', message: 'Requête invalide.', details: { issues: err.issues } } });
  }
  const status = (err as FastifyError).statusCode;
  if (status === 429) {
    return reply.status(429).send({ error: { code: 'RATE_LIMITED', message: 'Trop de tentatives. Réessayez dans une minute.' } });
  }
  if (status && status < 500) {
    return reply.status(status).send({ error: { code: 'BAD_REQUEST', message: err.message } });
  }
  req.log.error(err);
  return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Erreur interne.' } });
}
