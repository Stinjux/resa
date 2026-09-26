import { useEffect, useState } from 'react';
import { download, get, post, type User } from '../api';
import { money, todayIn } from '../format';
import { ErrorBox, useClubs } from './common';
import { ClosingDoc, DocOverlay, InvoiceDoc } from './Documents';

const METHOD_LABEL: Record<string, string> = {
  cash: 'Espèces', card_terminal: 'Carte (TPE)', bank_transfer: 'Virement', online: 'En ligne', pos: 'Caisse', other: 'Autre',
};
const toMinor = (v: string) => Math.round(Number(v.replace(',', '.').replace(/\s/g, '') || '0') * 100);
const when = (iso: string) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

export function Cash({ user }: { user: User }) {
  const clubs = useClubs(user, ['org_admin', 'club_admin', 'receptionist']);
  const [clubId, setClubId] = useState<string | null>(null);
  const club = clubs.find((c) => c.id === clubId);
  const finance = user.roles.some((r) => r.role === 'org_admin' || (r.role === 'club_admin' && r.clubId === clubId));
  useEffect(() => { if (!clubId && clubs[0]) setClubId(clubs[0].id); }, [clubs]);
  if (!clubId || !club) return null;
  return (
    <div className="stack">
      <div className="card row">
        <h2 style={{ margin: 0 }}>Caisse</h2>
        {clubs.length > 1 && (
          <select value={clubId} onChange={(e) => setClubId(e.target.value)}>
            {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
      </div>
      <CurrentCash key={clubId} clubId={clubId} />
      {finance && <InvoiceJournal key={`j-${clubId}`} clubId={clubId} timezone={club.timezone} />}
    </div>
  );
}

function CurrentCash({ clubId }: { clubId: string }) {
  const [cash, setCash] = useState<any>(null);
  const [closings, setClosings] = useState<any[]>([]);
  const [float, setFloat] = useState('0');
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [doc, setDoc] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => Promise.all([
    get(`/api/clubs/${clubId}/cash`).then((r) => setCash(r.cash)),
    get(`/api/clubs/${clubId}/cash/closings`).then((r) => setClosings(r.closings)),
  ]).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [clubId]);
  if (!cash) return <ErrorBox error={error} />;
  const cur = cash.currency;
  const expected = toMinor(float) + cash.expectedCashMinor;
  const diff = counted === '' ? null : toMinor(counted) - expected;
  const methods = Object.entries(cash.byMethod as Record<string, any>).filter(([, t]) => t.count > 0);

  async function close() {
    if (counted === '') return setError('Saisir les espèces comptées.');
    if (!window.confirm(`Clôturer la caisse ? ${cash.movements.length} opération(s), écart ${money(diff!, cur)}.`)) return;
    setBusy(true);
    setError(null);
    try {
      const r = await post(`/api/clubs/${clubId}/cash/closings`, { countedCashMinor: toMinor(counted), floatMinor: toMinor(float), note: note || null });
      setCounted(''); setNote('');
      await load();
      setDoc(r.closing);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="card stack">
        <h3 style={{ margin: 0 }}>Caisse en cours</h3>
        <p className="small muted" style={{ margin: 0 }}>
          {cash.since ? <>Depuis la clôture {cash.lastClosing} du {when(cash.since)}.</> : <>Aucune clôture pour l'instant.</>}
          {' '}Seuls les encaissements et remboursements confirmés sont comptés.
        </p>
        <div className="table-wrap">
          <table className="sheet">
            <thead><tr><th>Mode</th><th>Opérations</th><th>Encaissé</th><th>Remboursé</th><th>Net</th></tr></thead>
            <tbody>
              {methods.map(([m, t]) => (
                <tr key={m}><td>{METHOD_LABEL[m] ?? m}</td><td>{t.count}</td><td>{money(t.paidMinor, cur)}</td><td>{money(t.refundedMinor, cur)}</td><td><strong>{money(t.netMinor, cur)}</strong></td></tr>
              ))}
              {methods.length === 0 && <tr><td colSpan={5} className="muted">Aucune opération depuis la dernière clôture.</td></tr>}
              <tr><td colSpan={4}><strong>Total net</strong></td><td><strong>{money(cash.netMinor, cur)}</strong></td></tr>
            </tbody>
          </table>
        </div>
        <div className="grid2" style={{ maxWidth: 640 }}>
          <label>Fond de caisse ({cur})<input value={float} onChange={(e) => setFloat(e.target.value)} inputMode="decimal" /></label>
          <label>Espèces comptées ({cur})<input value={counted} onChange={(e) => setCounted(e.target.value)} inputMode="decimal" placeholder="Total du tiroir" /></label>
        </div>
        <div className="row small">
          <span>Espèces attendues : <strong>{money(expected, cur)}</strong></span>
          {diff !== null && <span className={diff === 0 ? 'badge ok' : 'badge warn'}>Écart {diff > 0 ? '+' : ''}{money(diff, cur)}</span>}
        </div>
        <label style={{ maxWidth: 640 }}>Commentaire<input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Explication d'un écart…" /></label>
        <ErrorBox error={error} />
        <div className="row"><button className="btn primary" disabled={busy} onClick={close}>Clôturer la caisse (Z)</button></div>
        {cash.movements.length > 0 && (
          <details>
            <summary className="small">Détail des {cash.movements.length} opération(s)</summary>
            <div className="table-wrap"><table className="sheet small">
              <thead><tr><th>Heure</th><th>Réservation</th><th>Opération</th><th>Mode</th><th>Par</th><th>Montant</th></tr></thead>
              <tbody>{cash.movements.map((m: any) => (
                <tr key={m.id}><td>{when(m.at)}</td><td>{m.reference}</td><td>{m.type === 'payment' ? 'Encaissement' : 'Remboursement'}</td>
                  <td>{METHOD_LABEL[m.method] ?? m.method}</td><td>{m.recordedBy ?? ''}</td><td>{m.type === 'refund' && '−'}{money(m.amountMinor, cur)}</td></tr>
              ))}</tbody>
            </table></div>
          </details>
        )}
      </div>

      <div className="card stack">
        <h3 style={{ margin: 0 }}>Clôtures</h3>
        <div className="table-wrap"><table className="sheet">
          <thead><tr><th>N°</th><th>Date</th><th>Par</th><th>Total net</th><th>Écart espèces</th><th /></tr></thead>
          <tbody>
            {closings.map((c) => (
              <tr key={c.id}>
                <td>{c.number}</td><td>{when(c.closedAt)}</td><td>{c.closedBy ?? ''}</td><td>{money(c.totals.netMinor, c.currency)}</td>
                <td><span className={c.differenceMinor === 0 ? 'badge ok' : 'badge warn'}>{c.differenceMinor > 0 ? '+' : ''}{money(c.differenceMinor, c.currency)}</span></td>
                <td><button className="btn sm" onClick={() => get(`/api/cash-closings/${c.id}`).then((r) => setDoc(r.closing)).catch((e) => setError(e.message))}>Voir</button></td>
              </tr>
            ))}
            {closings.length === 0 && <tr><td colSpan={6} className="muted">Aucune clôture.</td></tr>}
          </tbody>
        </table></div>
      </div>
      {doc && <DocOverlay onClose={() => setDoc(null)}><ClosingDoc closing={doc} /></DocOverlay>}
    </>
  );
}

function InvoiceJournal({ clubId, timezone }: { clubId: string; timezone: string }) {
  const today = todayIn(timezone);
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [invoices, setInvoices] = useState<any[] | null>(null);
  const [doc, setDoc] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const q = `from=${from}&to=${to}`;
  useEffect(() => {
    if (from && to) get(`/api/clubs/${clubId}/invoices?${q}`).then((r) => setInvoices(r.invoices)).catch((e) => setError(e.message));
  }, [clubId, from, to]);
  const sum = (k: string) => (invoices ?? []).reduce((n, i) => n + i[k], 0);
  const cur = invoices?.[0]?.currency ?? 'MAD';
  return (
    <div className="card stack">
      <div className="row">
        <h3 style={{ margin: 0 }}>Journal des factures et avoirs</h3>
        <span className="spacer" />
        <label className="row small">Du<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="row small">au<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button className="btn sm" onClick={() => download(`/api/clubs/${clubId}/invoices.csv?${q}`, `factures-${from}-${to}.csv`).catch((e) => setError(e.message))}>
          Export comptable (Excel)</button>
      </div>
      <ErrorBox error={error} />
      <div className="table-wrap"><table className="sheet">
        <thead><tr><th>Date</th><th>Numéro</th><th>Client</th><th>Réservation</th><th>HT</th><th>TVA</th><th>TTC</th><th /></tr></thead>
        <tbody>
          {invoices?.map((i) => (
            <tr key={i.id}>
              <td>{new Date(i.issuedAt).toLocaleDateString('fr-FR')}</td>
              <td>{i.number}{i.kind === 'credit_note' && <span className="small muted"> (avoir de {i.originalNumber})</span>}
                {i.creditNoteNumber && <span className="small muted"> (annulée)</span>}</td>
              <td>{i.buyer.name}</td><td>{i.bookingReference}</td>
              <td>{money(i.totalHtMinor, i.currency)}</td><td>{money(i.taxMinor, i.currency)}</td><td>{money(i.totalMinor, i.currency)}</td>
              <td><button className="btn sm" onClick={() => setDoc(i)}>Voir</button></td>
            </tr>
          ))}
          {invoices?.length === 0 && <tr><td colSpan={8} className="muted">Aucune facture sur la période.</td></tr>}
          {!!invoices?.length && (
            <tr><td colSpan={4}><strong>Total de la période</strong></td><td><strong>{money(sum('totalHtMinor'), cur)}</strong></td>
              <td><strong>{money(sum('taxMinor'), cur)}</strong></td><td><strong>{money(sum('totalMinor'), cur)}</strong></td><td /></tr>
          )}
        </tbody>
      </table></div>
      {doc && <DocOverlay onClose={() => setDoc(null)}><InvoiceDoc invoice={doc} /></DocOverlay>}
    </div>
  );
}
