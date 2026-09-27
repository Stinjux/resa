import { useEffect, useState } from 'react';
import { get, post, put } from '../api';
import { money, shortDate } from '../format';
import { ErrorBox } from './common';
import { errorText, useI18n } from '../i18n';
import { PaymentBadge } from './PaymentSection';
import { DocOverlay, InvoiceDoc, ReceiptDoc } from './Documents';

function BookingCard({ b, round, onChanged }: { b: any; round?: any; onChanged: () => void }) {
  const { t } = useI18n();
  const [order, setOrder] = useState<any>(null);
  const [preview, setPreview] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [invoices, setInvoices] = useState<any[]>([]);
  const [doc, setDoc] = useState<{ kind: 'invoice' | 'receipt'; data: any } | null>(null);
  const upcoming = b.status === 'confirmed' && new Date(b.teeTime.startsAt) > new Date();

  useEffect(() => {
    get(`/api/bookings/${b.id}/order`).then((r) => setOrder(r.order)).catch(() => undefined);
    get(`/api/bookings/${b.id}/invoices`).then((r) => setInvoices(r.invoices)).catch(() => undefined);
    if (upcoming) get(`/api/bookings/${b.id}/cancellation-preview`).then(setPreview).catch(() => undefined);
  }, [b.id, b.status]);

  async function cancel() {
    if (!confirm(t('mine.cancelConfirm'))) return;
    try {
      await post(`/api/me/bookings/${b.id}/cancel`);
      onChanged();
    } catch (e) {
      setError(errorText(t, e));
    }
  }

  return (
    <div className="card stack" style={{ gap: 6 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <strong>{t('mine.at', { date: shortDate(b.teeTime.localDate), time: b.teeTime.localTime })}</strong> · {t('mine.summary', { players: b.players, holes: b.holes })}
          {b.isPrivate && <span className="badge private"> {t('private')}</span>}
          <div className="small muted">{t('mine.ref', { ref: b.reference })} · {b.options.map((o: any) => `${o.name} × ${o.quantity}`).join(', ') || t('mine.noOption')}</div>
        </div>
        <div style={{ textAlign: 'end' }}>
          {b.status === 'cancelled' ? <span className="badge warn">{t('mine.cancelled')}</span> : <strong>{money(order?.totalMinor ?? b.pricing.totalMinor, b.pricing.currency)}</strong>}
          <div>{order && <PaymentBadge status={order.paymentStatus} />}</div>
        </div>
      </div>
      {upcoming && preview && (preview.customerCanCancel
        ? <div className="row small" style={{ alignItems: 'center' }}>
            <span className="muted">{t('mine.freeUntil', { date: new Date(preview.freeUntil).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) })}</span>
            <button className="btn sm danger" onClick={cancel}>{t('mine.cancel')}</button>
          </div>
        : <div className="small muted">{t('mine.contactGolf')}</div>)}
      {(order?.paidMinor > 0 || invoices.length > 0) && (
        <div className="row small">
          {order?.paidMinor > 0 && <button className="btn sm" onClick={() => get(`/api/bookings/${b.id}/receipt`)
            .then((r) => setDoc({ kind: 'receipt', data: r.receipt })).catch((e) => setError(errorText(t, e)))}>{t('mine.receipt')}</button>}
          {invoices.map((i) => (
            <button key={i.id} className="btn sm" onClick={() => get(`/api/invoices/${i.id}`)
              .then((r) => setDoc({ kind: 'invoice', data: r.invoice })).catch((e) => setError(errorText(t, e)))}>
              {t(i.kind === 'invoice' ? 'mine.invoice' : 'mine.creditNote')} {i.number}</button>
          ))}
        </div>
      )}
      {round && <Companions round={round} />}
      {upcoming && round && !b.isPrivate && <OpenToggle b={b} onChanged={onChanged} onError={(e) => setError(errorText(t, e))} />}
      <ErrorBox error={error} />
      {doc && (
        <DocOverlay onClose={() => setDoc(null)}>
          {doc.kind === 'invoice' ? <InvoiceDoc invoice={doc.data} /> : <ReceiptDoc receipt={doc.data} />}
        </DocOverlay>
      )}
    </div>
  );
}

/** Partenaires de jeu sur le même départ (nom abrégé et index s'ils l'acceptent). */
function Companions({ round }: { round: any }) {
  const { t } = useI18n();
  if (!round.companions.length) return <div className="small muted">{t('mine.alone')}</div>;
  return (
    <div className="small">{t('mine.with')} :{' '}
      {round.companions.map((c: any, i: number) => (
        <span key={i} className="chip-lite">{c.name ?? t('og.golfer')}{c.handicapIndex !== null && <span className="hcp">{c.handicapIndex}</span>}
          {c.players > 1 && <span className="muted"> {t('og.guests', { n: c.players - 1 })}</span>}</span>
      ))}
    </div>
  );
}

function OpenToggle({ b, onChanged, onError }: { b: any; onChanged: () => void; onError: (e: unknown) => void }) {
  const { t } = useI18n();
  const [note, setNote] = useState(b.openNote ?? '');
  const save = (isOpen: boolean) => put(`/api/me/bookings/${b.id}/open`, { isOpen, openNote: note || null }).then(onChanged).catch(onError);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <label className="check"><input type="checkbox" checked={b.isOpen} onChange={(e) => save(e.target.checked)} /> {t('mine.open')}</label>
      {b.isOpen && <div className="row"><input style={{ flex: 1 }} placeholder={t('mine.openNote')} value={note} maxLength={200}
        onChange={(e) => setNote(e.target.value)} onBlur={() => note !== (b.openNote ?? '') && save(true)} /></div>}
    </div>
  );
}

function PastRound({ r }: { r: any }) {
  const { t } = useI18n();
  return (
    <div className="card stack" style={{ gap: 4 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>{t('mine.at', { date: shortDate(r.date), time: r.localTime })}</strong>
        {r.status === 'cancelled' ? <span className="badge warn">{t('mine.cancelled')}</span>
          : r.checkinStatus === 'no_show' ? <span className="badge warn">{t('mine.noShow')}</span> : null}
      </div>
      <div className="small muted">{r.clubName} · {r.courseName} · {t('mine.summary', { players: r.players, holes: r.holes })}</div>
      {r.status === 'confirmed' && <Companions round={r} />}
    </div>
  );
}

export function MyBookings() {
  const { t } = useI18n();
  const [bookings, setBookings] = useState<any[] | null>(null);
  const [rounds, setRounds] = useState<any>(null);
  const [tab, setTab] = useState<'upcoming' | 'history'>('upcoming');
  const load = () => {
    get('/api/me/bookings').then((r) => setBookings(r.bookings));
    get('/api/me/rounds').then((r) => setRounds(r.rounds)).catch(() => undefined);
  };
  useEffect(() => { load(); }, []);
  if (!bookings) return null;
  const byId = new Map<string, any>([...(rounds?.upcoming ?? []), ...(rounds?.past ?? [])].map((r: any) => [r.id, r]));
  const upcoming = bookings.filter((b) => b.status === 'confirmed' && new Date(b.teeTime.startsAt) > new Date())
    .sort((a, b) => a.teeTime.startsAt.localeCompare(b.teeTime.startsAt));
  return (
    <div className="stack golfer">
      <h1>{t('mine.title')}</h1>
      {rounds && <div className="small muted">{t('mine.stats', { n: rounds.stats.roundsLast12Months, r18: rounds.stats.rounds18, r9: rounds.stats.rounds9 })}</div>}
      <nav className="nav segmented">
        <button className={tab === 'upcoming' ? 'active' : ''} onClick={() => setTab('upcoming')}>{t('mine.upcoming')} ({upcoming.length})</button>
        <button className={tab === 'history' ? 'active' : ''} onClick={() => setTab('history')}>{t('mine.history')}</button>
      </nav>
      {tab === 'upcoming' && <>
        {upcoming.length === 0 && <p className="muted">{t('mine.none')}</p>}
        {upcoming.map((b) => <BookingCard key={b.id + b.status + b.isOpen} b={b} round={byId.get(b.id)} onChanged={load} />)}
      </>}
      {tab === 'history' && <>
        {!rounds?.past.length && <p className="muted">{t('mine.noHistory')}</p>}
        {rounds?.past.map((r: any) => <PastRound key={r.id} r={r} />)}
      </>}
    </div>
  );
}
