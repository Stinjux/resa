import { useEffect, useState } from 'react';
import { get, post } from '../api';
import { money } from '../format';
import { ErrorBox } from './common';
import { useI18n } from '../i18n';
import { DocOverlay, InvoiceDoc, ReceiptDoc } from './Documents';

export const PAYMENT_STATUS: Record<string, [string, string]> = {
  nothing_due: ['Rien à payer', 'badge'],
  unpaid: ['À payer', 'badge warn'],
  partially_paid: ['Partiellement payé', 'badge warn'],
  paid: ['Payé', 'badge ok'],
  refund_due: ['À rembourser', 'badge private'],
};

const METHODS: Array<[string, string]> = [['cash', 'Espèces'], ['card_terminal', 'Carte (TPE)'], ['bank_transfer', 'Virement'], ['other', 'Autre']];
const METHOD_LABEL: Record<string, string> = { ...Object.fromEntries(METHODS), online: 'En ligne', pos: 'Caisse' };

export function PaymentBadge({ status }: { status: string | null | undefined }) {
  const { t } = useI18n();
  if (!status) return null;
  const [, cls] = PAYMENT_STATUS[status] ?? [status, 'badge'];
  return <span className={cls}>{t(`pay.${status}` as never)}</span>;
}

/** Solde, paiements et remboursements d'une réservation ; encaisser / rembourser. */
export function PaymentSection({ bookingId, canManage, canFinance = false, onChanged }: {
  bookingId: string; canManage: boolean; canFinance?: boolean; onChanged: () => void;
}) {
  const [order, setOrder] = useState<any>(null);
  const [mode, setMode] = useState<'pay' | 'refund' | null>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('cash');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => get(`/api/bookings/${bookingId}/order`).then((r) => setOrder(r.order)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [bookingId]);
  if (!order) return <ErrorBox error={error} />;
  const cur = order.currency;

  function open(m: 'pay' | 'refund') {
    setMode(m);
    setError(null);
    setNote('');
    setAmount(String(Math.abs(m === 'pay' ? order.balanceMinor : Math.min(-order.balanceMinor || order.paidMinor, order.paidMinor)) / 100));
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const amountMinor = Math.round(Number(amount.replace(',', '.')) * 100);
      await post(`/api/bookings/${bookingId}/${mode === 'pay' ? 'payments' : 'refunds'}`,
        mode === 'pay' ? { amountMinor, method, note: note || null } : { amountMinor, method, reason: note || null },
        { 'Idempotency-Key': crypto.randomUUID() });
      setMode(null);
      await load();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const moves = [
    ...order.payments.map((p: any) => ({ ...p, sign: 1, label: `Paiement · ${METHOD_LABEL[p.method] ?? p.method}` })),
    ...order.refunds.map((r: any) => ({ ...r, sign: -1, label: `Remboursement · ${METHOD_LABEL[r.method] ?? r.method}` })),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Règlement</h3>
        <PaymentBadge status={order.paymentStatus} />
      </div>
      <table className="lines"><tbody>
        <tr><td>Total dû{order.status === 'cancelled' && ' (annulée)'}</td><td>{money(order.totalMinor, cur)}</td></tr>
        <tr><td>Payé</td><td>{money(order.paidMinor, cur)}</td></tr>
        {order.pendingMinor > 0 && <tr><td className="muted">En attente de confirmation (non compté)</td><td className="muted">{money(order.pendingMinor, cur)}</td></tr>}
        <tr className="total"><td>{order.balanceMinor >= 0 ? 'Reste à payer' : 'À rembourser'}</td><td>{money(Math.abs(order.balanceMinor), cur)}</td></tr>
      </tbody></table>
      {moves.length > 0 && (
        <div className="small muted stack" style={{ gap: 2 }}>
          {moves.map((m) => (
            <div key={m.id}>{new Date(m.createdAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })} · {m.label} ·
              {' '}{m.sign < 0 && '−'}{money(m.amountMinor, cur)}{m.status !== 'confirmed' && ` (${m.status})`}{m.recordedBy && ` · ${m.recordedBy}`}</div>
          ))}
        </div>
      )}
      {order.externalRefs.length > 0 && (
        <div className="small muted">Caisse : {order.externalRefs.map((r: any) => `${r.provider} ${r.externalId}`).join(', ')}</div>
      )}
      {canManage && !mode && (
        <div className="row">
          {order.balanceMinor > 0 && <button className="btn sm primary" onClick={() => open('pay')}>Encaisser</button>}
          {order.paidMinor > 0 && <button className="btn sm" onClick={() => open('refund')}>Rembourser</button>}
        </div>
      )}
      {mode && (
        <div className="card stack" style={{ background: 'var(--surface-2)' }}>
          <div className="grid2">
            <label>Montant ({cur})<input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" /></label>
            <label>Moyen<select value={method} onChange={(e) => setMethod(e.target.value)}>
              {METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          </div>
          <label>{mode === 'pay' ? 'Note' : 'Motif'}<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <ErrorBox error={error} />
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={submit}>{mode === 'pay' ? 'Confirmer l\'encaissement' : 'Confirmer le remboursement'}</button>
            <button className="btn" onClick={() => setMode(null)}>Annuler</button>
          </div>
          <p className="small muted" style={{ margin: 0 }}>À valider uniquement une fois l'argent réellement reçu ou rendu.</p>
        </div>
      )}
      {!mode && <ErrorBox error={error} />}
      <BillingDocs bookingId={bookingId} canManage={canManage} canFinance={canFinance} totalMinor={order.totalMinor} />
    </div>
  );
}

/** Reçu, factures et avoirs d'une réservation. */
function BillingDocs({ bookingId, canManage, canFinance, totalMinor }: { bookingId: string; canManage: boolean; canFinance: boolean; totalMinor: number }) {
  const [invoices, setInvoices] = useState<any[]>([]);
  const [doc, setDoc] = useState<{ kind: 'invoice' | 'receipt'; data: any } | null>(null);
  const [form, setForm] = useState<{ name: string; address: string; ice: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => get(`/api/bookings/${bookingId}/invoices`).then((r) => setInvoices(r.invoices)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [bookingId]);
  const active = invoices.find((i) => i.kind === 'invoice' && !i.creditNoteNumber);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  const showInvoice = (id: string) => run(async () => setDoc({ kind: 'invoice', data: (await get(`/api/invoices/${id}`)).invoice }));
  const issue = () => run(async () => {
    const r = await post(`/api/bookings/${bookingId}/invoices`, { buyer: { name: form!.name || undefined, address: form!.address || null, ice: form!.ice || null } });
    setForm(null);
    await load();
    setDoc({ kind: 'invoice', data: r.invoice });
  });
  const credit = (id: string, number: string) => {
    const reason = window.prompt(`Motif de l'avoir annulant la facture ${number} :`);
    if (!reason) return;
    run(async () => { const r = await post(`/api/invoices/${id}/credit-note`, { reason }); await load(); setDoc({ kind: 'invoice', data: r.invoice }); });
  };

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row">
        <strong className="small">Documents</strong>
        <button className="btn sm" disabled={busy} onClick={() => run(async () => setDoc({ kind: 'receipt', data: (await get(`/api/bookings/${bookingId}/receipt`)).receipt }))}>Reçu</button>
        {canManage && !active && totalMinor > 0 && !form && (
          <button className="btn sm" onClick={() => setForm({ name: '', address: '', ice: '' })}>Facturer</button>
        )}
      </div>
      {invoices.map((i) => (
        <div key={i.id} className="row small">
          <button className="btn sm" onClick={() => showInvoice(i.id)}>{i.kind === 'invoice' ? 'Facture' : 'Avoir'} {i.number}</button>
          <span>{money(i.totalMinor, i.currency)}</span>
          {i.creditNoteNumber && <span className="muted">annulée par {i.creditNoteNumber}</span>}
          {canFinance && i.kind === 'invoice' && !i.creditNoteNumber && <button className="btn sm" disabled={busy} onClick={() => credit(i.id, i.number)}>Avoir</button>}
        </div>
      ))}
      {form && (
        <div className="card stack" style={{ background: 'var(--surface-2)' }}>
          <label>Nom ou raison sociale<input value={form.name} placeholder="Par défaut : nom du client" onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>Adresse<input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} /></label>
          <label>ICE du client (entreprise)<input value={form.ice} onChange={(e) => setForm({ ...form, ice: e.target.value })} /></label>
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={issue}>Émettre la facture</button>
            <button className="btn" onClick={() => setForm(null)}>Annuler</button>
          </div>
          <p className="small muted" style={{ margin: 0 }}>Une facture émise ne se modifie plus : une erreur se corrige par un avoir (direction).</p>
        </div>
      )}
      <ErrorBox error={error} />
      {doc && (
        <DocOverlay onClose={() => setDoc(null)}>
          {doc.kind === 'invoice' ? <InvoiceDoc invoice={doc.data} /> : <ReceiptDoc receipt={doc.data} />}
        </DocOverlay>
      )}
    </div>
  );
}

/** Annulation avec aperçu des frais selon la politique du golf. */
export function CancelControl({ bookingId, onCancelled }: { bookingId: string; onCancelled: () => void }) {
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const [reason, setReason] = useState('');
  const [waive, setWaive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function show() {
    setOpen(true);
    setPreview(await get(`/api/bookings/${bookingId}/cancellation-preview`));
  }
  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await post(`/api/bookings/${bookingId}/cancel`, { reason: reason || null, waiveFee: waive });
      onCancelled();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!open) return <button className="btn danger" onClick={show}>Annuler la réservation</button>;
  return (
    <div className="card stack" style={{ borderColor: 'var(--danger)' }}>
      <h3 style={{ margin: 0 }}>Annuler la réservation</h3>
      {preview && (preview.feeMinor > 0
        ? <p className="small" style={{ margin: 0 }}>Annulation tardive : frais de <strong>{money(preview.feeMinor, preview.currency)}</strong> (gratuit jusqu'au {new Date(preview.freeUntil).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}).</p>
        : <p className="small" style={{ margin: 0 }}>Sans frais. Caddie et matériel seront libérés.</p>)}
      {preview?.feeMinor > 0 && <label className="check"><input type="checkbox" checked={waive} onChange={(e) => setWaive(e.target.checked)} /> Renoncer aux frais</label>}
      <label>Motif<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
      <ErrorBox error={error} />
      <div className="row">
        <button className="btn danger" disabled={busy} onClick={confirm}>Confirmer l'annulation</button>
        <button className="btn" onClick={() => setOpen(false)}>Retour</button>
      </div>
    </div>
  );
}
