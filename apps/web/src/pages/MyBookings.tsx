import { useEffect, useState } from 'react';
import { get } from '../api';
import { money } from '../format';

export function MyBookings() {
  const [bookings, setBookings] = useState<any[] | null>(null);
  useEffect(() => { get('/api/me/bookings').then((r) => setBookings(r.bookings)); }, []);
  if (!bookings) return null;
  return (
    <div className="stack" style={{ maxWidth: 820 }}>
      <h1>Mes réservations</h1>
      {bookings.length === 0 && <p className="muted">Aucune réservation.</p>}
      {bookings.map((b) => (
        <div key={b.id} className="card row" style={{ justifyContent: 'space-between' }}>
          <div>
            <strong>{b.teeTime.localDate} à {b.teeTime.localTime}</strong> · {b.players} joueur(s) · {b.holes} trous
            {b.isPrivate && <span className="badge private"> Privé</span>}
            <div className="small muted">Réf. {b.reference} · {b.options.map((o: any) => `${o.name} × ${o.quantity}`).join(', ') || 'sans option'}</div>
          </div>
          <div>
            {b.status === 'cancelled' ? <span className="badge warn">Annulée</span> : <strong>{money(b.pricing.totalMinor, b.pricing.currency)}</strong>}
          </div>
        </div>
      ))}
    </div>
  );
}
