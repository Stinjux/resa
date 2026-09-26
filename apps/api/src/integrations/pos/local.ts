// Adaptateur local : aucun système externe. Il produit des identifiants
// déterministes, ce qui permet de faire fonctionner et de tester toute la
// chaîne de synchronisation (file, reprises, correspondances) sans POS.

import type { PosCallContext, PosConnector, PosPayment, PosRefund, PosResult, PosSale } from './contract.js';

export class LocalPosConnector implements PosConnector {
  readonly provider = 'local';
  readonly capabilities = { sales: true, payments: true, refunds: true, priceMode: 'both' } as const;

  async upsertSale(sale: PosSale, ctx: PosCallContext): Promise<PosResult> {
    return { externalId: ctx.existingExternalId ?? `local-sale-${sale.orderId}`, data: { version: sale.version } };
  }
  async recordPayment(payment: PosPayment, ctx: PosCallContext): Promise<PosResult> {
    return { externalId: ctx.existingExternalId ?? `local-payment-${payment.paymentId}` };
  }
  async recordRefund(refund: PosRefund, ctx: PosCallContext): Promise<PosResult> {
    return { externalId: ctx.existingExternalId ?? `local-refund-${refund.refundId}` };
  }
}
