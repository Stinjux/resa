// Registre des connecteurs POS disponibles. Pour brancher un fournisseur :
// implémenter PosConnector dans un fichier dédié (ex. ./acme.ts) et l'ajouter
// ici, en lisant ses clés depuis l'environnement (voir docs/POS.md).

import type { PosConnector } from './contract.js';
import { LocalPosConnector } from './local.js';

export type PosRegistry = Map<string, PosConnector>;

export function createPosRegistry(extra: PosConnector[] = []): PosRegistry {
  const registry: PosRegistry = new Map();
  for (const c of [new LocalPosConnector(), ...extra]) registry.set(c.provider, c);
  return registry;
}
