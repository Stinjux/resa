import { useCallback, useEffect, useMemo, useState } from 'react';
import { get, put, type User } from '../api';
import { addDays, longDate, money, todayIn } from '../format';
import { ErrorBox, useClubs } from './common';
import { PaymentBadge } from './PaymentSection';

interface Equipment { allocationId: string; resourceTypeId: string; name: string; quantity: number; units: Array<{ id: string; label: string }> }
interface BoardBooking { id: string; reference: string; players: number; customerName: string | null; playerNames: Array<string | null>;
  caddiePayment: string; dueOnSiteMinor: number | null; notes: string | null; equipment: Equipment[];
  paymentStatus: string; balanceMinor: number }
interface BoardTeeTime { teeTimeId: string; localDate: string; localTime: string; course: { name: string }; holes: number; isPrivate: boolean;
  players: number; remaining: number; caddie: { reserved: boolean; caddieId: string | null; name: string | null }; bookings: BoardBooking[] }

export function StarterBoard({ user }: { user: User }) {
  const clubs = useClubs(user, ['org_admin', 'club_admin', 'starter']);
  const [clubId, setClubId] = useState<string | null>(null);
  const club = clubs.find((c) => c.id === clubId);
  const [date, setDate] = useState('');
  const [days, setDays] = useState(1);
  const [board, setBoard] = useState<BoardTeeTime[]>([]);
  const [caddies, setCaddies] = useState<Array<{ id: string; displayName: string; active: boolean }>>([]);
  const [units, setUnits] = useState<Array<{ id: string; label: string; status: string; resourceTypeId: string }>>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (!clubId && clubs[0]) setClubId(clubs[0].id); }, [clubs]);
  useEffect(() => {
    if (!club) return;
    setDate(todayIn(club.timezone));
    get(`/api/clubs/${club.id}/caddies`).then((r) => setCaddies(r.caddies));
    get(`/api/clubs/${club.id}/resource-units`).then((r) => setUnits(r.units));
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
              const busyCaddies = new Set(board.filter((x) => x.teeTimeId !== t.teeTimeId && x.caddie.caddieId).map((x) => x.caddie.caddieId));
              return (
                <div key={t.teeTimeId} className="card tt-card">
                  <div>
                    <div className="time" style={{ fontSize: 20 }}>{t.localTime}</div>
                    <div className="small muted">{t.course.name}</div>
                    <div className="small">{t.players} j · {t.holes} trous</div>
                    {t.isPrivate && <span className="badge private">Privé</span>}
                  </div>
                  <div className="stack" style={{ gap: 8 }}>
                    {t.bookings.map((b) => (
                      <div key={b.id}>
                        <strong>{b.customerName ?? b.reference}</strong> <span className="muted small">{b.reference} · {b.players} joueur(s)</span>
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
                        {b.equipment.map((e) => {
                          const pool = units.filter((u) => u.resourceTypeId === e.resourceTypeId && u.status === 'available');
                          return (
                            <div key={e.allocationId} className="row small" style={{ gap: 6, alignItems: 'center', marginTop: 4 }}>
                              <span>{e.name} × {e.quantity} :</span>
                              {Array.from({ length: e.quantity }, (_, i) => (
                                <select key={i} value={e.units[i]?.id ?? ''} onChange={(ev) => {
                                  const ids = e.units.map((u) => u.id);
                                  if (ev.target.value) ids[i] = ev.target.value; else ids.splice(i, 1);
                                  act(() => put(`/api/allocations/${e.allocationId}/units`, { unitIds: ids.filter(Boolean) }));
                                }}>
                                  <option value="">— n° —</option>
                                  {pool.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
                                </select>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                  <div>
                    <label>Caddie
                      <select value={t.caddie.caddieId ?? ''} disabled={!t.caddie.reserved}
                        onChange={(e) => act(() => put(`/api/tee-times/${t.teeTimeId}/caddie`, { caddieId: e.target.value || null }))}>
                        <option value="">{t.caddie.reserved ? '— à attribuer —' : 'non réservé'}</option>
                        {caddies.filter((c) => c.active).map((c) => (
                          <option key={c.id} value={c.id}>{c.displayName}{busyCaddies.has(c.id) ? ' (occupé ailleurs)' : ''}</option>
                        ))}
                      </select>
                    </label>
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
