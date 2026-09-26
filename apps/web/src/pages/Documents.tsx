// Documents imprimables : facture / avoir, reçu, ticket de clôture (Z).
// Affichés dans une fenêtre par-dessus l'application ; seule cette fenêtre
// est imprimée.

import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const METHOD_LABEL: Record<string, string> = {
  cash: 'Espèces', card_terminal: 'Carte (TPE)', bank_transfer: 'Virement', online: 'En ligne', pos: 'Caisse', other: 'Autre',
};

/** Montant avec décimales (documents comptables). */
function amount(minor: number, currency: string) {
  return new Intl.NumberFormat('fr-FR', { style: 'currency', currency, minimumFractionDigits: 2 }).format(minor / 100);
}
const dateTime = (iso: string, timeZone?: string) =>
  new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone }).format(new Date(iso));
const dateOnly = (iso: string, timeZone?: string) => new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone }).format(new Date(iso));

export function DocOverlay({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    document.body.classList.add('printing-doc');
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => { document.body.classList.remove('printing-doc'); window.removeEventListener('keydown', esc); };
  }, []);
  return createPortal(
    <div className="doc-overlay" onClick={onClose}>
      <div className="doc-toolbar" onClick={(e) => e.stopPropagation()}>
        <button className="btn primary" onClick={() => window.print()}>Imprimer / PDF</button>
        <button className="btn" onClick={onClose}>Fermer</button>
      </div>
      <div className="doc-paper" onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>,
    document.body,
  );
}

function SellerBlock({ s }: { s: any }) {
  return (
    <div>
      <strong style={{ fontSize: 16 }}>{s.legalName ?? s.name}</strong>
      {s.legalName && s.legalName !== s.name && <div>{s.name}</div>}
      {s.address && <div style={{ whiteSpace: 'pre-line' }}>{s.address}</div>}
      {s.phone && <div>Tél. {s.phone}</div>}
      {s.email && <div>{s.email}</div>}
    </div>
  );
}

function LegalFooter({ s }: { s: any }) {
  const ids = [s.ice && `ICE : ${s.ice}`, s.taxId && `IF : ${s.taxId}`, s.tradeRegister && `RC : ${s.tradeRegister}`, s.patente && `Patente : ${s.patente}`]
    .filter(Boolean).join(' · ');
  return (
    <div className="doc-footer">
      <div>{[s.legalName ?? s.name, s.address].filter(Boolean).join(' — ')}</div>
      {ids && <div>{ids}</div>}
      {s.footer && <div style={{ whiteSpace: 'pre-line' }}>{s.footer}</div>}
    </div>
  );
}

export function InvoiceDoc({ invoice: i }: { invoice: any }) {
  const cur = i.currency;
  const credit = i.kind === 'credit_note';
  const byRate = new Map<number, { ht: number; tax: number }>();
  for (const l of i.lines) {
    const r = byRate.get(l.taxRateBp) ?? { ht: 0, tax: 0 };
    r.ht += l.totalHtMinor; r.tax += l.taxMinor;
    byRate.set(l.taxRateBp, r);
  }
  return (
    <div className="doc">
      <div className="doc-head">
        <SellerBlock s={i.seller} />
        <div style={{ textAlign: 'right' }}>
          <div className="doc-title">{credit ? 'AVOIR' : 'FACTURE'}</div>
          <div>N° <strong>{i.number}</strong></div>
          <div>Date : {dateOnly(i.issuedAt)}</div>
          {!credit && i.dueDate && <div>Échéance : {dateOnly(`${i.dueDate}T12:00:00Z`)}</div>}
          {credit && <div>Annule la facture <strong>{i.originalNumber}</strong></div>}
        </div>
      </div>
      <div className="doc-buyer">
        <div className="small muted">Client</div>
        <strong>{i.buyer.name}</strong>
        {i.buyer.address && <div style={{ whiteSpace: 'pre-line' }}>{i.buyer.address}</div>}
        {i.buyer.ice && <div>ICE : {i.buyer.ice}</div>}
      </div>
      <div className="small">{(i.bookingIds?.length ?? 1) > 1 ? 'Réservations' : 'Réservation'} {i.bookingReference}
        {i.payer === 'partner' && !credit && (i.bookingIds?.length ?? 1) === 1 && ' — part prise en charge par le partenaire'}
        {credit && i.reason && <> · Motif : {i.reason}</>}</div>
      <table className="doc-table">
        <thead><tr><th>Désignation</th><th>Qté</th><th>PU HT</th><th>TVA</th><th>Total HT</th></tr></thead>
        <tbody>
          {i.lines.map((l: any, n: number) => (
            <tr key={n}><td>{l.label}</td><td>{l.quantity}</td><td>{amount(l.unitHtMinor, cur)}</td><td>{l.taxRateBp / 100} %</td><td>{amount(l.totalHtMinor, cur)}</td></tr>
          ))}
        </tbody>
      </table>
      <table className="doc-totals"><tbody>
        <tr><td>Total HT</td><td>{amount(i.totalHtMinor, cur)}</td></tr>
        {[...byRate.entries()].map(([rate, r]) => <tr key={rate}><td>TVA {rate / 100} % (base {amount(r.ht, cur)})</td><td>{amount(r.tax, cur)}</td></tr>)}
        <tr className="grand"><td>Total TTC</td><td>{amount(i.totalMinor, cur)}</td></tr>
        {!credit && <tr><td>Déjà réglé</td><td>{amount(i.paidMinor, cur)}</td></tr>}
        {!credit && i.totalMinor - i.paidMinor > 0 && <tr><td>Reste à payer</td><td>{amount(i.totalMinor - i.paidMinor, cur)}</td></tr>}
      </tbody></table>
      <p>Arrêté{credit ? ' le présent avoir' : 'e la présente facture'} à la somme de <strong>{amount(Math.abs(i.totalMinor), cur)}</strong> TTC.</p>
      <LegalFooter s={i.seller} />
    </div>
  );
}

export function ReceiptDoc({ receipt: r }: { receipt: any }) {
  const cur = r.order.currency;
  return (
    <div className="doc">
      <div className="doc-head">
        <SellerBlock s={r.seller} />
        <div style={{ textAlign: 'right' }}>
          <div className="doc-title">REÇU</div>
          <div>Réservation <strong>{r.booking.reference}</strong></div>
          <div>Édité le {dateTime(r.printedAt, r.timezone)}</div>
        </div>
      </div>
      <div className="doc-buyer">
        {r.booking.customerName && <div><strong>{r.booking.customerName}</strong></div>}
        <div>Départ du {dateTime(r.booking.startsAt, r.timezone)} · {r.booking.courseName} · {r.booking.players} joueur(s) · {r.booking.holes} trous
          {r.booking.status === 'cancelled' && ' · annulée'}</div>
      </div>
      <table className="doc-table">
        <thead><tr><th>Désignation</th><th>Qté</th><th>Montant TTC</th></tr></thead>
        <tbody>{r.lines.map((l: any, n: number) => <tr key={n}><td>{l.label}</td><td>{l.quantity}</td><td>{amount(l.totalMinor, cur)}</td></tr>)}</tbody>
      </table>
      <table className="doc-totals"><tbody>
        <tr className="grand"><td>Total TTC</td><td>{amount(r.order.totalMinor, cur)}</td></tr>
        {r.movements.map((m: any, n: number) => (
          <tr key={n}><td>{m.type === 'payment' ? 'Réglé' : 'Remboursé'} le {dateTime(m.at, r.timezone)} · {METHOD_LABEL[m.method] ?? m.method}</td>
            <td>{amount(m.amountMinor, cur)}</td></tr>
        ))}
        <tr><td>{r.order.balanceMinor >= 0 ? 'Reste à payer' : 'À rembourser'}</td><td>{amount(Math.abs(r.order.balanceMinor), cur)}</td></tr>
        {r.order.split.partner.totalMinor > 0 && <>
          <tr><td>dont part client</td><td>{amount(r.order.split.customer.balanceMinor, cur)}</td></tr>
          <tr><td>dont part partenaire (facturée au partenaire)</td><td>{amount(r.order.split.partner.balanceMinor, cur)}</td></tr>
        </>}
      </tbody></table>
      <p className="small">Ce reçu atteste des règlements enregistrés ; il ne vaut pas facture.</p>
      <LegalFooter s={r.seller} />
    </div>
  );
}

export function ClosingDoc({ closing: c }: { closing: any }) {
  const cur = c.currency;
  const rows = Object.entries(c.totals.byMethod as Record<string, any>).filter(([, t]) => t.count > 0);
  return (
    <div className="doc">
      <div className="doc-head">
        <SellerBlock s={c.seller} />
        <div style={{ textAlign: 'right' }}>
          <div className="doc-title">CLÔTURE DE CAISSE</div>
          <div>N° <strong>{c.number}</strong></div>
          <div>{c.periodStart ? `Du ${dateTime(c.periodStart, c.timezone)} au ${dateTime(c.closedAt, c.timezone)}` : `Première clôture, le ${dateTime(c.closedAt, c.timezone)}`}</div>
          {c.closedBy && <div>Par {c.closedBy}</div>}
        </div>
      </div>
      <table className="doc-table">
        <thead><tr><th>Mode</th><th>Opérations</th><th>Encaissé</th><th>Remboursé</th><th>Net</th></tr></thead>
        <tbody>
          {rows.map(([m, t]) => (
            <tr key={m}><td>{METHOD_LABEL[m] ?? m}</td><td>{t.count}</td><td>{amount(t.paidMinor, cur)}</td><td>{amount(t.refundedMinor, cur)}</td><td>{amount(t.netMinor, cur)}</td></tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={5}>Aucune opération sur la période.</td></tr>}
        </tbody>
      </table>
      <table className="doc-totals"><tbody>
        <tr className="grand"><td>Total net</td><td>{amount(c.totals.netMinor, cur)}</td></tr>
        <tr><td>Fond de caisse</td><td>{amount(c.floatMinor, cur)}</td></tr>
        <tr><td>Espèces attendues</td><td>{amount(c.expectedCashMinor, cur)}</td></tr>
        <tr><td>Espèces comptées</td><td>{amount(c.countedCashMinor, cur)}</td></tr>
        <tr className="grand"><td>Écart</td><td>{c.differenceMinor > 0 ? '+' : ''}{amount(c.differenceMinor, cur)}</td></tr>
      </tbody></table>
      {c.note && <p>Commentaire : {c.note}</p>}
      <h4>Détail des opérations</h4>
      <table className="doc-table small">
        <thead><tr><th>Heure</th><th>Réservation</th><th>Opération</th><th>Mode</th><th>Par</th><th>Montant</th></tr></thead>
        <tbody>{c.movements.map((m: any) => (
          <tr key={m.id}><td>{dateTime(m.at, c.timezone)}</td><td>{m.reference}</td><td>{m.type === 'payment' ? 'Encaissement' : 'Remboursement'}</td>
            <td>{METHOD_LABEL[m.method] ?? m.method}</td><td>{m.recordedBy ?? ''}</td><td>{m.type === 'refund' && '−'}{amount(m.amountMinor, cur)}</td></tr>
        ))}</tbody>
      </table>
      <div className="doc-sign"><div>Signature caissier</div><div>Signature responsable</div></div>
    </div>
  );
}
