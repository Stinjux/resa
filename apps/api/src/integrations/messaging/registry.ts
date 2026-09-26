// Registre des connecteurs de messagerie. Brancher un fournisseur : créer
// ./<fournisseur>.ts qui implémente MessagingConnector et l'ajouter ici
// (clés lues dans l'environnement). Voir docs/MESSAGERIE.md.

import type { MessagingConnector } from './contract.js';
import { LocalMessagingConnector } from './local.js';

export type MessagingRegistry = Map<string, MessagingConnector>;

export function createMessagingRegistry(extra: MessagingConnector[] = []): MessagingRegistry {
  const registry: MessagingRegistry = new Map();
  for (const c of [new LocalMessagingConnector(), ...extra]) registry.set(c.provider, c);
  return registry;
}
