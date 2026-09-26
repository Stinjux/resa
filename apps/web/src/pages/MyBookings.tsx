import { useEffect, useState } from 'react';
import { get, post } from '../api';
import { money } from '../format';
import { ErrorBox } from './common';
import { PaymentBadge } from './PaymentSection';

function BookingCard({ b, onChanged }: { b: any; onChanged: () => void }) {
  const [order, setOrder] = useState<any>(null);
  const [preview, setPreview] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const upcoming = b.status === 'confirmed' && new Date(b.teeTime.startsAt) > new Date();

  useEffect(() => {
    get(`/api/bookings/${b.id}/order`).then((r) => setOrder(r.order)).catch(() => undefined);
    if (upcoming) get(`/api/bookings/${b.id}/cancellation-preview`).then(setPreview).catch(() => undefined);
  }, [b.id, b.status]);

  async function cancel() {
    if (!confirm('Annuler cette réservation ?')) return;
    try {
      await post(`/api/me/bookings/${b.id}/cancel`);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="card stack" style={{ gap: 6 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <strong>{b.teeTime.localDate} à {b.teeTime.localTime}</strong> · {b.players} joueur(s) · {b.holes} trous
          {b.isPrivate && <span className="badge private"> Privé</span>}
          <div className="small muted">Réf. {b.reference} · {b.options.map((o: any) => `${o.name} × ${o.quantity}`).join(', ') || 'sans option'}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          {b.status === 'cancelled' ? <span className="badge warn">Annulée</span> : <strong>{money(order?.totalMinor ?? b.pricing.totalMinor, b.pricing.currency)}</strong>}
          <div>{order && <PaymentBadge status={order.paymentStatus} />}</div>
        </div>
      </div>
      {upcoming && preview && (preview.customerCanCancel
        ? <div className="row small" style={{ alignItems: 'center' }}>
            <span className="muted">Annulation gratuite jusqu'au {new Date(preview.freeUntil).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</span>
            <button className="btn sm danger" onClick={cancel}>Annuler</button>
          </div>
        : <div className="small muted">Pour annuler, contactez le golf.</div>)}
      <ErrorBox error={error} />
    </div>
  );
}

export function MyBookings() {
  const [bookings, setBookings] = useState<any[] | null>(null);
  const load = () => get('/api/me/bookings').then((r) => setBookings(r.bookings));
  useEffect(() => { load(); }, []);
  if (!bookings) return null;
  return (
    <div className="stack" style={{ maxWidth: 820 }}>
      <h1>Mes réservations</h1>
      {bookings.length === 0 && <p className="muted">Aucune réservation.</p>}
      {bookings.map((b) => <BookingCard key={b.id + b.status} b={b} onChanged={load} />)}
    </div>
  );
}
