// Accès au modèle d'IA (Claude, API Anthropic). Remplaçable dans les tests.
//
// Clé : variable d'environnement ANTHROPIC_API_KEY (jamais en base ni dans le
// code). Sans clé, les fonctions IA répondent AI_NOT_CONFIGURED ; le reste de
// Resa fonctionne normalement.

import Anthropic from '@anthropic-ai/sdk';
import { DomainError } from '../../shared/errors.js';

export type AiRequest = Omit<Anthropic.Beta.MessageCreateParamsNonStreaming, 'model' | 'betas' | 'fallbacks'>;

export interface AiModel {
  readonly name: string;
  create(request: AiRequest): Promise<Anthropic.Beta.BetaMessage>;
}

export const DEFAULT_AI_MODEL = 'claude-opus-5';

export function createAnthropicModel(apiKey: string, model = DEFAULT_AI_MODEL): AiModel {
  const client = new Anthropic({ apiKey });
  return {
    name: model,
    create: (request) =>
      client.beta.messages.create({
        ...request,
        model,
        // Si le modèle refuse une demande, l'API la rejoue sur le modèle de repli recommandé.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      }),
  };
}

/** Modèle configuré par l'environnement, ou null si aucune clé. */
export function modelFromEnv(env: NodeJS.ProcessEnv = process.env): AiModel | null {
  const key = env.ANTHROPIC_API_KEY?.trim();
  return key ? createAnthropicModel(key, env.AI_MODEL?.trim() || DEFAULT_AI_MODEL) : null;
}

export function requireModel(model: AiModel | null): AiModel {
  if (!model) {
    throw new DomainError('AI_NOT_CONFIGURED', "L'IA n'est pas configurée : ajoutez ANTHROPIC_API_KEY sur le serveur.");
  }
  return model;
}

/** Traduit les erreurs de l'API Anthropic en erreurs lisibles. */
export function aiError(err: unknown): never {
  if (err instanceof Anthropic.AuthenticationError) throw new DomainError('AI_UNAVAILABLE', 'Clé API Anthropic invalide.');
  if (err instanceof Anthropic.RateLimitError) throw new DomainError('AI_UNAVAILABLE', 'Service IA saturé : réessayez dans un instant.');
  if (err instanceof Anthropic.APIConnectionError) throw new DomainError('AI_UNAVAILABLE', 'Service IA injoignable.');
  if (err instanceof Anthropic.APIError) throw new DomainError('AI_UNAVAILABLE', `Erreur du service IA (${err.status}).`);
  throw err;
}

export function textOf(message: Anthropic.Beta.BetaMessage): string {
  return message.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}
