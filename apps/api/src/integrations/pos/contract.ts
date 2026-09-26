// Contrat d'un connecteur POS (point de vente).
//
// Aucun fournisseur n'est encore choisi : ce fichier définit ce que Resa
// ENVOIE et ATTEND, sans supposer d'API particulière. Un connecteur réel
// traduit ces objets vers l'API du fournisseur (voir docs/POS.md).
//
// Règles pour toute implémentation :
//  - Idempotence : chaque appel reçoit `ctx.idempotencyKey`, stable d'une
//    reprise à l'autre. Si le fournisseur accepte une clé d'idempotence, la
//    lui transmettre ; sinon, utiliser `ctx.existingExternalId` pour mettre à
//    jour au lieu de recréer.
//  - Erreurs : lever PosError(retryable=true) pour une panne passagère
//    (réseau, 429, 5xx) et retryable=false pour un refus définitif (400,
//    donnée invalide) : le job passe alors en erreur sans boucler.
//  - Ne jamais considérer un paiement comme confirmé sans confirmation du
//    fournisseur ou du personnel.

export interface PosCapabilities {
  sales: boolean; // créer / mettre à jour une vente
  payments: boolean; // enregistrer un paiement reçu dans Resa
  refunds: boolean; // enregistrer un remboursement
  /** Le fournisseur attend-il des prix TTC ou HT ? */
  priceMode: 'tax_inclusive' | 'tax_exclusive' | 'both';
}

export interface PosCustomer {
  id: string; // identifiant interne stable Resa
  externalId: string | null; // identifiant chez le fournisseur, s'il est connu
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
}

export interface PosLine {
  position: number;
  sku: string; // GREEN_FEE_18, CADDIE, CART, BAG_MEN_RH, CANCELLATION_FEE…
  label: string;
  quantity: number;
  unitAmountMinor: number;
  totalMinor: number; // TTC si pricesIncludeTax, sinon HT + taxe
  taxRateBp: number; // 2000 = 20 %
  taxMinor: number;
}

export interface PosSale {
  orderId: string; // identifiant interne stable (clé de correspondance)
  version: number; // augmente à chaque modification des lignes
  reference: string; // référence lisible (ex. G1-000042)
  clubId: string;
  clubCode: string;
  currency: string; // ISO 4217
  pricesIncludeTax: boolean;
  status: 'open' | 'cancelled';
  bookingId: string;
  teeTimeStartsAt: string; // ISO 8601 UTC
  customer: PosCustomer | null;
  lines: PosLine[];
  totalMinor: number;
  taxMinor: number;
}

export interface PosPayment {
  paymentId: string;
  orderId: string;
  saleExternalId: string;
  amountMinor: number;
  currency: string;
  method: string; // cash, card_terminal, bank_transfer, online, other
  confirmedAt: string;
}

export interface PosRefund {
  refundId: string;
  orderId: string;
  saleExternalId: string;
  paymentExternalId: string | null;
  amountMinor: number;
  currency: string;
  method: string;
  reason: string | null;
  confirmedAt: string;
}

export interface PosCallContext {
  idempotencyKey: string;
  existingExternalId: string | null;
}

export interface PosResult {
  externalId: string;
  data?: Record<string, unknown>; // informations utiles à conserver (n° de ticket…)
}

export interface PosConnector {
  readonly provider: string;
  readonly capabilities: PosCapabilities;
  upsertSale(sale: PosSale, ctx: PosCallContext): Promise<PosResult>;
  recordPayment?(payment: PosPayment, ctx: PosCallContext): Promise<PosResult>;
  recordRefund?(refund: PosRefund, ctx: PosCallContext): Promise<PosResult>;
}

export class PosError extends Error {
  constructor(message: string, public readonly retryable: boolean) {
    super(message);
    this.name = 'PosError';
  }
}
