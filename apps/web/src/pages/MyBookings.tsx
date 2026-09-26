import { useEffect, useState } from 'react';
import { get, post } from '../api';
import { money } from '../format';
import { ErrorBox } from './common';
import { errorText, useI18n } from '../i18n';
import { PaymentBadge } from './PaymentSection';

function BookingCard({ b, onChanged }: { b: any; onChanged: () => void }) {
  const { t } = useI18n();
  const [order, setOrder] = useState<any>(null);
  const [preview, setPreview] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const upcoming = b.status === 'confirmed' && new Date(b.teeTime.startsAt) > new Date();

  useEffect(() => {
    get(`/api/bookings/${b.id}/order`).then((r) => setOrder(r.order)).catch(() => undefined);
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
          <strong>{t('mine.at', { date: b.teeTime.localDate, time: b.teeTime.localTime })}</strong> · {t('mine.summary', { players: b.players, holes: b.holes })}
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
      <ErrorBox error={error} />
    </div>
  );
}

export function MyBookings() {
  const { t } = useI18n();
  const [bookings, setBookings] = useState<any[] | null>(null);
  const load = () => get('/api/me/bookings').then((r) => setBookings(r.bookings));
  useEffect(() => { load(); }, []);
  if (!bookings) return null;
  return (
    <div className="stack" style={{ maxWidth: 820 }}>
      <h1>{t('mine.title')}</h1>
      {bookings.length === 0 && <p className="muted">{t('mine.none')}</p>}
      {bookings.map((b) => <BookingCard key={b.id + b.status} b={b} onChanged={load} />)}
    </div>
  );
}
