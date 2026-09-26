// Simulateur : aucun envoi réel. Les messages « envoyés » restent visibles
// dans Resa ; les messages entrants se saisissent depuis l'écran Demandes.

import type { MessagingConnector, OutboundMessage } from './contract.js';

export class LocalMessagingConnector implements MessagingConnector {
  readonly provider = 'local';
  readonly channels = ['whatsapp', 'sms'] as const as Array<'whatsapp' | 'sms'>;
  async send(_message: OutboundMessage, ctx: { idempotencyKey: string }) {
    return { providerMessageId: `local-${ctx.idempotencyKey}` };
  }
}
