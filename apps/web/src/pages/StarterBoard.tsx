import { useCallback, useEffect, useMemo, useState } from 'react';
import { get, put, type User } from '../api';
import { addDays, longDate, money, todayIn } from '../format';
import { ErrorBox, useClubs } from './common';
import { PaymentBadge } from './PaymentSection';
import { CaddieAssign, UnitsAssign } from '../components/resources';

interface Equipment { allocationId: string; resourceTypeId: string; name: string; quantity: number; units: Array<{ id: string; label: string }> }
interface BoardBooking { id: string; reference: string; players: number; customerName: string | null; playerNames: Array<string | null>;
  checkinStatus: 'expected' | 'arrived' | 'no_show';
  caddiePayment: string; dueOnSiteMinor: number | null; notes: string | null; equipment: Equipment[];
  paymentStatus: string; balanceMinor: number }
interface BoardTeeTime { teeTimeId: string; localDate: string; localTime: string; course: { name: string }; holes: number; isPrivate: boolean;
  startedAt: string | null;
  players: number; remaining: number; caddie: { reserved: boolean; caddieId: string | null; name: string | null }; bookings: BoardBooking[] }

export function StarterBoard({ user }: { user: User }) {
  const clubs = useClubs(user, ['org_admin', 'club_admin', 'starter']);
  const [clubId, setClubId] = useState<string | null>(null);
  const club = clubs.find((c) => c.id === clubId);
  const [date, setDate] = useState('');
  const [days, setDays] = useState(1);
  const [board, setBoard] = useState<BoardTeeTime[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (!clubId && clubs[0]) setClubId(clubs[0].id); }, [clubs]);
  useEffect(() => {
    if (!club) return;
    setDate(todayIn(club.timezone));
  }, [club?.id]);

  const load = useCallback(() => {
    if (!clubId || !date) return;
    get(`/api/clubs/${clubId}/starter?date=${date}&days=${days}`)
      .then((r) => { setBoard(r.teeTimes); setError(null); })
      .catch((e) => { setBoard([]); setError(e.message); });
  }, [clubId, date, days]);
  useEffect(load, [load]);

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); }
    load();
  }

  const byDay = useMemo(() => {
    const m = new Map<string, BoardTeeTime[]>();
    for (const t of board) m.set(t.localDate, [...(m.get(t.localDate) ?? []), t]);
    return [...m.entries()];
  }, [board]);
  const today = club ? todayIn(club.timezone) : '';

  return (
    <div className="stack">
      <div className="card row">
        {clubs.length > 1 && (
          <label>Golf<select value={clubId ?? ''} onChange={(e) => setClubId(e.target.value)}>
            {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        )}
        <div className="row" style={{ gap: 4 }}>
          <button className={`btn sm ${days === 1 && date === today ? 'primary' : ''}`} onClick={() => { setDate(today); setDays(1); }}>Aujourd'hui</button>
          <button className={`btn sm ${days === 1 && date === addDays(today, 1) ? 'primary' : ''}`} onClick={() => { setDate(addDays(today, 1)); setDays(1); }}>Demain</button>
          <button className={`btn sm ${days === 7 ? 'primary' : ''}`} onClick={() => { setDate(today); setDays(7); }}>Semaine</button>
        </div>
        <span className="spacer" />
        <button className="btn sm no-print" onClick={() => window.print()}>🖨 Imprimer</button>
        <span className="small muted">{board.length} départ(s) · {board.reduce((n, t) => n + t.players, 0)} joueurs ·
          {' '}{board.filter((t) => t.caddie.reserved && !t.caddie.name).length} caddie(s) à nommer</span>
      </div>
      <ErrorBox error={error} />
      {byDay.length === 0 && !error && <div className="card muted">Aucun départ réservé sur cette période.</div>}
      {byDay.map(([day, list]) => (
        <section key={day}>
          <h2 className="day-title">{longDate(day)}</h2>
          <div className="stack">
            {list.map((t) => {
              return (
                <div key={t.teeTimeId} className="card tt-card">
                  <div>
                    <div className="time" style={{ fontSize: 20 }}>{t.localTime}</div>
                    <div className="small muted">{t.course.name}</div>
                    <div className="small">{t.players} j · {t.holes} trous</div>
                    {t.isPrivate && <span className="badge private">Privé</span>}
                    <div className="no-print" style={{ marginTop: 6 }}>
                      <button className={`btn sm ${t.startedAt ? 'primary' : ''}`}
                        onClick={() => act(() => put(`/api/tee-times/${t.teeTimeId}/started`, { started: !t.startedAt }))}>
                        {t.startedAt ? '✓ Parti' : 'Départ parti'}</button>
                    </div>
                  </div>
                  <div className="stack" style={{ gap: 8 }}>
                    {t.bookings.map((b) => (
                      <div key={b.id}>
                        <strong>{b.customerName ?? b.reference}</strong> <span className="muted small">{b.reference} · {b.players} joueur(s)</span>
                        {' '}{b.checkinStatus === 'arrived' && <span className="badge ok">arrivé</span>}
                        {b.checkinStatus === 'no_show' && <span className="badge warn">absent</span>}
                        <span className="no-print" style={{ marginInlineStart: 6 }}>
                          {b.checkinStatus !== 'arrived' && <button className="btn sm" onClick={() => act(() => put(`/api/bookings/${b.id}/checkin`, { status: 'arrived' }))}>Arrivé</button>}
                          {b.checkinStatus === 'expected' && <button className="btn sm" onClick={() => act(() => put(`/api/bookings/${b.id}/checkin`, { status: 'no_show' }))}>Absent</button>}
                          {b.checkinStatus !== 'expected' && <button className="btn sm" onClick={() => act(() => put(`/api/bookings/${b.id}/checkin`, { status: 'expected' }))}>Annuler</button>}
                        </span>
                        {b.playerNames.some(Boolean) && <div className="small muted">{b.playerNames.filter(Boolean).join(', ')}</div>}
                        <div className="small">
                          Caddie {b.caddiePayment === 'on_site'
                            ? <span className="badge warn">à encaisser sur place</span>
                            : <span className="badge ok">payé avec la réservation</span>}
                          {b.balanceMinor > 0
                            ? <> · <strong>reste à payer : {money(b.balanceMinor, club?.currency)}</strong></>
                            : <> · <PaymentBadge status={b.paymentStatus} /></>}
                        </div>
                        {b.notes && <div className="small">📝 {b.notes}</div>}
                        {b.equipment.map((e) => (
                          <div key={e.allocationId} className="small" style={{ marginTop: 4 }}>
                            <span>{e.name} × {e.quantity}</span>
                            <UnitsAssign allocationId={e.allocationId} typeName={e.name} quantity={e.quantity} units={e.units} canAssign onChanged={load} />
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                  <div className="no-print-controls">
                    <CaddieAssign teeTimeId={t.teeTimeId} reserved={t.caddie.reserved} name={t.caddie.name} canAssign onChanged={load} />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
