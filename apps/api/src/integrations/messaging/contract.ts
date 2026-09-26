// Contrat d'un connecteur de messagerie (WhatsApp, SMS).
//
// Aucun fournisseur n'est encore choisi (Meta WhatsApp Business Platform,
// Twilio, opérateur SMS marocain…) : ce fichier définit ce que Resa attend,
// sans supposer d'API. Voir docs/MESSAGERIE.md.

export type MessagingChannel = 'whatsapp' | 'sms';

export interface InboundMessage {
  channel: MessagingChannel;
  from: string; // numéro de l'expéditeur, tel que fourni
  to: string | null; // numéro du golf qui a reçu le message (permet de trouver le golf)
  fromName: string | null;
  text: string;
  providerMessageId: string; // identifiant unique chez le fournisseur (anti-doublon)
  receivedAt: Date;
}

export interface OutboundMessage {
  channel: MessagingChannel;
  to: string;
  text: string;
}

export interface WebhookRequest {
  method: string;
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
  rawBody: string;
}

export interface MessagingConnector {
  readonly provider: string;
  readonly channels: MessagingChannel[];
  /** Envoi. Lever MessagingError(retryable) en cas d'échec. */
  send(message: OutboundMessage, ctx: { idempotencyKey: string }): Promise<{ providerMessageId: string }>;
  /**
   * Notification entrante du fournisseur : vérifier la signature, puis
   * extraire les messages. `challenge` sert aux vérifications d'URL
   * (ex. hub.challenge) ; null sinon.
   */
  handleWebhook?(req: WebhookRequest): Promise<{ messages: InboundMessage[]; challenge?: string | null }>;
}

export class MessagingError extends Error {
  constructor(message: string, public readonly retryable: boolean) {
    super(message);
    this.name = 'MessagingError';
  }
}
