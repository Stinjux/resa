import { useCallback, useEffect, useMemo, useState } from 'react';
import { download, get, patch, post, put, type Club, type User } from '../api';
import { addDays, CHANNEL_LABEL, longDate, money, todayIn } from '../format';
import { ErrorBox, useClubs, useCourses } from './common';
import { CancelControl, PaymentBadge, PaymentSection } from './PaymentSection';

interface SheetBooking {
  id: string; reference: string; players: number; holes: number; isPrivate: boolean; channel: string;
  groupId: string | null; customerName: string | null; customerPhone: string | null; paymentStatus?: string;
  checkinStatus: 'expected' | 'arrived' | 'no_show'; customerNoShows: number;
  resources: Array<{ code: string; name: string; quantity: number }>;
}
export interface SheetRow {
  teeTimeId: string | null; startsAt: string; localTime: string; inGrid: boolean; maxPlayers: number;
  bookedPlayers: number; remaining: number; holes: number | null; allowedHoles: number[]; isPrivate: boolean;
  blockedReason: string | null; startedAt: string | null;
  caddie: { reserved: boolean; caddieId: string | null; name: string | null }; bookings: SheetBooking[];
}

type PanelState = { kind: 'block' } | { kind: 'new'; row: SheetRow } | { kind: 'group'; row: SheetRow } | { kind: 'booking'; id: string } | null;

function canFinance(user: User, clubId: string) {
  return user.roles.some((r) => (r.clubId === clubId && r.role === 'club_admin') || r.role === 'org_admin');
}

function canManage(user: User, clubId: string) {
  return user.roles.some((r) => (r.clubId === clubId && ['club_admin', 'receptionist'].includes(r.role)) || r.role === 'org_admin');
}

export function TeeSheet({ user }: { user: User }) {
  const clubs = useClubs(user, ['org_admin', 'club_admin', 'receptionist', 'starter']);
  const [clubId, setClubId] = useState<string | null>(null);
  const club = clubs.find((c) => c.id === clubId);
  const courses = useCourses(clubId);
  const [courseId, setCourseId] = useState<string | null>(null);
  const [date, setDate] = useState('');
  const [rows, setRows] = useState<SheetRow[]>([]);
  const [onlyBooked, setOnlyBooked] = useState(false);
  const [panel, setPanel] = useState<PanelState>(null);
  const [panelVersion, setPanelVersion] = useState(0); // recharge le panneau après une action
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (!clubId && clubs[0]) setClubId(clubs[0].id); }, [clubs]);
  useEffect(() => { setCourseId(courses[0]?.id ?? null); }, [courses]);
  useEffect(() => { if (club) setDate(todayIn(club.timezone)); }, [club?.id]);

  const load = useCallback(() => {
    if (!courseId || !date) return;
    setError(null);
    get<{ rows: SheetRow[] }>(`/api/courses/${courseId}/tee-sheet?date=${date}`)
      .then((r) => setRows(r.rows))
      .catch((e) => { setRows([]); setError(e.message); });
  }, [courseId, date]);
  useEffect(() => { load(); setPanel(null); }, [load]);

  const manage = !!clubId && canManage(user, clubId);
  const visible = onlyBooked ? rows.filter((r) => r.bookedPlayers > 0) : rows;
  const stats = useMemo(() => {
    const grid = rows.filter((r) => r.inGrid);
    return {
      teeTimes: rows.filter((r) => r.bookedPlayers > 0).length,
      players: rows.reduce((n, r) => n + r.bookedPlayers, 0),
      free: grid.reduce((n, r) => n + r.remaining, 0),
    };
  }, [rows]);

  function refresh(bookingId?: string) {
    load();
    setPanelVersion((v) => v + 1);
    setPanel(bookingId ? { kind: 'booking', id: bookingId } : null);
  }

  return (
    <div className="stack">
      <div className="card row">
        {clubs.length > 1 && (
          <label>Golf<select value={clubId ?? ''} onChange={(e) => setClubId(e.target.value)}>
            {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        )}
        <label>Parcours<select value={courseId ?? ''} onChange={(e) => setCourseId(e.target.value)}>
          {courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <div className="row" style={{ gap: 4 }}>
          <button className="btn sm" onClick={() => setDate(addDays(date, -1))}>◀</button>
          <button className="btn sm" onClick={() => club && setDate(todayIn(club.timezone))}>Aujourd'hui</button>
          <button className="btn sm" onClick={() => setDate(addDays(date, 1))}>▶</button>
        </div>
        <label className="check"><input type="checkbox" checked={onlyBooked} onChange={(e) => setOnlyBooked(e.target.checked)} /> Départs occupés seulement</label>
        <span className="spacer" />
        <span className="small muted">{stats.teeTimes} départs · {stats.players} joueurs · {stats.free} places libres</span>
        <div className="row no-print" style={{ gap: 4 }}>
          {manage && <button className="btn sm" onClick={() => setPanel({ kind: 'block' })}>🔒 Bloquer…</button>}
          <button className="btn sm" onClick={() => window.print()}>🖨 Imprimer</button>
          <button className="btn sm" onClick={() => courseId && download(`/api/courses/${courseId}/tee-sheet.csv?date=${date}`, `departs-${date}.csv`).catch((e) => setError(e.message))}>⬇ Excel</button>
        </div>
      </div>
      {date && <h2 style={{ textTransform: 'capitalize' }}>{club?.name} — {longDate(date)}</h2>}
      <ErrorBox error={error} />
      <div className="layout">
        <div className="card table-wrap">
          <table className="sheet">
            <thead><tr><th>Heure</th><th>Places</th><th>Formule</th><th>Réservations</th><th>Caddie</th></tr></thead>
            <tbody>
              {visible.map((r) => {
                const selected = (panel?.kind === 'new' || panel?.kind === 'group') && panel.row.startsAt === r.startsAt;
                const clickable = manage && r.remaining > 0;
                return (
                  <tr key={r.startsAt} className={`${clickable ? 'slot' : ''} ${selected ? 'selected' : ''} ${r.blockedReason ? 'blocked' : ''}`}
                    onClick={() => clickable && setPanel({ kind: 'new', row: r })}>
                    <td className="time">{r.localTime}{!r.inGrid && <span className="badge warn"> hors grille</span>}
                      {r.startedAt && <span className="badge ok" title="Départ parti"> parti</span>}
                      {r.blockedReason && <div className="small" style={{ fontWeight: 400 }}><span className="badge warn">🔒 {r.blockedReason}</span>
                        {manage && <button className="btn sm no-print" style={{ marginInlineStart: 4 }} onClick={(e) => { e.stopPropagation();
                          post(`/api/courses/${courseId}/unblock`, { date, from: r.localTime, to: r.localTime }).then(load).catch((er) => setError(er.message)); }}>Débloquer</button>}</div>}</td>
                    <td>
                      <span className="seats" title={`${r.bookedPlayers}/${r.maxPlayers}`}>
                        {Array.from({ length: r.maxPlayers }, (_, i) => (
                          <span key={i} className={`seat ${i < r.bookedPlayers ? 'taken' : r.isPrivate ? 'blocked' : ''}`} />
                        ))}
                      </span>
                      {r.isPrivate && <span className="badge private" style={{ marginLeft: 6 }}>Privé</span>}
                    </td>
                    <td>{r.holes ? `${r.holes} t.` : <span className="muted small">{r.allowedHoles.join('/')}</span>}</td>
                    <td>
                      {r.bookings.map((b) => (
                        <span key={b.id} className="chip" onClick={(e) => { e.stopPropagation(); setPanel({ kind: 'booking', id: b.id }); }}>
                          <strong>{b.customerName ?? b.reference}</strong> · {b.players} j
                          <span className="muted small">{CHANNEL_LABEL[b.channel]}</span>
                          {b.resources.length > 0 && <span className="muted small">🛒{b.resources.reduce((n, x) => n + x.quantity, 0)}</span>}
                          {b.paymentStatus && b.paymentStatus !== 'unpaid' && <PaymentBadge status={b.paymentStatus} />}
                          {b.checkinStatus === 'arrived' && <span className="badge ok">arrivé</span>}
                          {b.checkinStatus === 'no_show' && <span className="badge warn">absent</span>}
                          {b.customerNoShows > 0 && <span className="badge warn" title="Absences passées de ce client">⚠ {b.customerNoShows} abs.</span>}
                        </span>
                      ))}
                    </td>
                    <td className="small">
                      {r.caddie.name ? r.caddie.name : r.caddie.reserved ? <span className="badge ok">réservé</span> : ''}
                    </td>
                  </tr>
                );
              })}
              {visible.length === 0 && <tr><td colSpan={5} className="muted">Aucun départ.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="panel">
          {!panel && (
            <div className="card muted small">
              {manage ? 'Cliquez sur un créneau pour créer une réservation, ou sur une réservation pour la modifier, la réunir ou l\'annuler.'
                : 'Consultation seule.'}
            </div>
          )}
          {panel?.kind === 'block' && courseId && (
            <BlockPanel courseId={courseId} date={date} onDone={load} onClose={() => setPanel(null)} />
          )}
          {panel?.kind === 'new' && club && courseId && (
            <NewBookingPanel key={panel.row.startsAt} club={club} courseId={courseId} row={panel.row}
              onGroup={() => setPanel({ kind: 'group', row: panel.row })} onSaved={refresh} onClose={() => setPanel(null)} />
          )}
          {panel?.kind === 'group' && club && courseId && (
            <GroupPanel club={club} courseId={courseId} row={panel.row} rows={rows} onSaved={() => refresh()} onClose={() => setPanel(null)} />
          )}
          {panel?.kind === 'booking' && (
            <BookingPanel key={`${panel.id}-${panelVersion}`} id={panel.id} rows={rows} courseId={courseId!} canManage={manage}
              canFinance={!!clubId && canFinance(user, clubId)} onChanged={refresh} onClose={() => setPanel(null)} />
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function CustomerPicker({ clubId, value, onChange }: {
  clubId: string;
  value: { id?: string; label?: string; lastName: string; firstName: string; phone: string; email: string };
  onChange: (v: { id?: string; label?: string; lastName: string; firstName: string; phone: string; email: string }) => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<any[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) return setResults([]);
    const t = setTimeout(() => get(`/api/clubs/${clubId}/customers?q=${encodeURIComponent(q)}`).then((r) => setResults(r.customers)), 250);
    return () => clearTimeout(t);
  }, [q]);

  if (value.id) {
    return (
      <div className="row" style={{ alignItems: 'center' }}>
        <span>Golfeur : <strong>{value.label}</strong></span>
        <button className="btn sm" onClick={() => onChange({ lastName: '', firstName: '', phone: '', email: '' })}>Changer</button>
      </div>
    );
  }
  return (
    <div className="stack">
      <label>Rechercher un golfeur du golf<input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nom, téléphone ou e-mail" /></label>
      {results.map((c) => (
        <button key={c.id} className="btn sm" style={{ textAlign: 'left' }}
          onClick={() => onChange({ ...value, id: c.id, label: `${c.firstName ?? ''} ${c.lastName} ${c.phone ?? ''}`.trim() })}>
          {c.firstName} {c.lastName} <span className="muted">{c.phone ?? c.email}</span>
        </button>
      ))}
      <div className="small muted">…ou nouveau golfeur :</div>
      <div className="grid2">
        <label>Nom *<input value={value.lastName} onChange={(e) => onChange({ ...value, lastName: e.target.value })} /></label>
        <label>Prénom<input value={value.firstName} onChange={(e) => onChange({ ...value, firstName: e.target.value })} /></label>
        <label>Téléphone<input type="tel" value={value.phone} onChange={(e) => onChange({ ...value, phone: e.target.value })} /></label>
        <label>E-mail<input type="email" value={value.email} onChange={(e) => onChange({ ...value, email: e.target.value })} /></label>
      </div>
    </div>
  );
}

function customerPayload(c: { id?: string; lastName: string; firstName: string; phone: string; email: string }) {
  if (c.id) return { customerId: c.id };
  if (!c.lastName.trim()) return {};
  return { customer: { lastName: c.lastName.trim(), firstName: c.firstName || null, phone: c.phone || null, email: c.email || null } };
}

function QuoteLines({ quote }: { quote: any }) {
  if (!quote) return null;
  return (
    <table className="lines"><tbody>
      {quote.lines.map((l: any, i: number) => (
        <tr key={i}><td>{l.label}{l.quantity > 1 && ` × ${l.quantity}`}{l.payable === 'on_site' && <span className="badge"> sur place</span>}</td>
          <td>{money(l.totalMinor, quote.currency)}</td></tr>
      ))}
      <tr className="total"><td>Total TTC</td><td>{money(quote.totalMinor, quote.currency)}</td></tr>
      {quote.dueOnSiteMinor > 0 && <tr><td className="muted">dont sur place</td><td className="muted">{money(quote.dueOnSiteMinor, quote.currency)}</td></tr>}
    </tbody></table>
  );
}

function NewBookingPanel({ club, courseId, row, onSaved, onClose, onGroup }: {
  club: Club; courseId: string; row: SheetRow; onSaved: (id?: string) => void; onClose: () => void; onGroup: () => void;
}) {
  const holesChoices = row.holes ? [row.holes] : row.allowedHoles;
  const [players, setPlayers] = useState(Math.min(2, row.remaining));
  const [holes, setHoles] = useState(holesChoices.includes(18) ? 18 : holesChoices[0]!);
  const [isPrivate, setIsPrivate] = useState(false);
  const [channel, setChannel] = useState('phone');
  const [category, setCategory] = useState('standard');
  const [categories, setCategories] = useState<string[]>(['standard']);
  const [caddiePayment, setCaddiePayment] = useState<'on_site' | 'with_booking'>('on_site');
  const [options, setOptions] = useState<any[]>([]);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [customer, setCustomer] = useState({ lastName: '', firstName: '', phone: '', email: '' } as any);
  const [notes, setNotes] = useState('');
  const [quote, setQuote] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { get(`/api/clubs/${club.id}/customer-categories`).then((r) => setCategories(r.categories)); }, [club.id]);
  useEffect(() => {
    get(`/api/courses/${courseId}/options?startsAt=${encodeURIComponent(row.startsAt)}&holes=${holes}`).then((r) => setOptions(r.options));
  }, [holes]);
  const optionList = useMemo(() => Object.entries(qty).filter(([, q]) => q > 0).map(([resourceTypeId, quantity]) => ({ resourceTypeId, quantity })), [qty]);
  useEffect(() => {
    post('/api/quote', { courseId, startsAt: row.startsAt, players, holes, isPrivate, caddiePayment, customerCategory: category, options: optionList })
      .then((r) => { setQuote(r.quote); setError(null); })
      .catch((e) => { setQuote(null); setError(e.message); });
  }, [players, holes, isPrivate, caddiePayment, category, optionList]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await post('/api/bookings', {
        courseId, startsAt: row.startsAt, players, holes, isPrivate, channel, customerCategory: category, caddiePayment,
        options: optionList, notes: notes || null, ...customerPayload(customer),
      }, { 'Idempotency-Key': crypto.randomUUID() });
      onSaved(r.booking.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>Nouvelle réservation · {row.localTime}</h2>
        <button className="btn sm" onClick={onClose}>✕</button>
      </div>
      <div className="small muted">{row.remaining} place(s) libre(s){row.bookedPlayers > 0 && ` — départ partagé avec ${row.bookings.map((b) => b.customerName).join(', ')}`}</div>
      <div className="grid2">
        <label>Canal<select value={channel} onChange={(e) => setChannel(e.target.value)}>
          <option value="phone">Téléphone</option><option value="walk_in">Sur place</option><option value="staff">Personnel</option></select></label>
        <label>Joueurs<select value={players} onChange={(e) => setPlayers(Number(e.target.value))}>
          {Array.from({ length: row.remaining }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}</select></label>
        <label>Formule<select value={holes} onChange={(e) => setHoles(Number(e.target.value))} disabled={holesChoices.length === 1}>
          {holesChoices.map((h) => <option key={h} value={h}>{h} trous</option>)}</select></label>
        <label>Tarif<select value={category} onChange={(e) => setCategory(e.target.value)}>
          {categories.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
      </div>
      {row.bookedPlayers === 0 && <label className="check"><input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} /> Départ privé</label>}
      <label className="check"><input type="checkbox" checked={caddiePayment === 'with_booking'} onChange={(e) => setCaddiePayment(e.target.checked ? 'with_booking' : 'on_site')} /> Caddie payé avec la réservation (sinon sur place)</label>
      <div className="grid2">
        {options.map((o) => (
          <label key={o.resourceTypeId}>{o.name} ({o.available} dispo)
            <select value={qty[o.resourceTypeId] ?? 0} onChange={(e) => setQty({ ...qty, [o.resourceTypeId]: Number(e.target.value) })}>
              {Array.from({ length: Math.min(o.available, 4) + 1 }, (_, i) => <option key={i} value={i}>{i}</option>)}</select>
          </label>
        ))}
      </div>
      <CustomerPicker clubId={club.id} value={customer} onChange={setCustomer} />
      <label>Notes<textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      <QuoteLines quote={quote} />
      <ErrorBox error={error} />
      <div className="row">
        <button className="btn primary" disabled={busy || !quote} onClick={save}>Enregistrer</button>
        {row.bookedPlayers === 0 && <button className="btn" onClick={onGroup}>Réservation de groupe…</button>}
      </div>
    </div>
  );
}

function GroupPanel({ club, courseId, row, rows, onSaved, onClose }: {
  club: Club; courseId: string; row: SheetRow; rows: SheetRow[]; onSaved: () => void; onClose: () => void;
}) {
  const [total, setTotal] = useState(8);
  const [holes, setHoles] = useState(18);
  const [customer, setCustomer] = useState({ lastName: '', firstName: '', phone: '', email: '' } as any);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Répartit le groupe par 4 sur les départs libres consécutifs à partir du créneau choisi.
  const plan = useMemo(() => {
    const start = rows.findIndex((r) => r.startsAt === row.startsAt);
    const free = rows.slice(start).filter((r) => r.inGrid && r.bookedPlayers === 0 && r.allowedHoles.includes(holes));
    const items: Array<{ row: SheetRow; players: number }> = [];
    let left = total;
    for (const r of free) {
      if (left <= 0) break;
      const n = Math.min(r.maxPlayers, left);
      items.push({ row: r, players: n });
      left -= n;
    }
    return { items, missing: left };
  }, [total, holes, rows, row]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await post('/api/booking-groups', {
        channel: 'group', ...customerPayload(customer),
        items: plan.items.map((i) => ({ courseId, startsAt: i.row.startsAt, players: i.players, holes })),
      }, { 'Idempotency-Key': crypto.randomUUID() });
      onSaved();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>Groupe à partir de {row.localTime}</h2>
        <button className="btn sm" onClick={onClose}>✕</button>
      </div>
      <div className="grid2">
        <label>Nombre de joueurs<input type="number" min={1} max={200} value={total} onChange={(e) => setTotal(Number(e.target.value))} /></label>
        <label>Formule<select value={holes} onChange={(e) => setHoles(Number(e.target.value))}>
          {row.allowedHoles.map((h) => <option key={h} value={h}>{h} trous</option>)}</select></label>
      </div>
      <div className="small">
        {plan.items.map((i) => <span key={i.row.startsAt} className="chip">{i.row.localTime} · {i.players} j</span>)}
        {plan.missing > 0 && <div className="alert">Pas assez de départs libres consécutifs ({plan.missing} joueur(s) sans départ).</div>}
      </div>
      <CustomerPicker clubId={club.id} value={customer} onChange={setCustomer} />
      <ErrorBox error={error} />
      <button className="btn primary" disabled={busy || plan.missing > 0 || plan.items.length === 0} onClick={save}>
        Réserver {plan.items.length} départ(s)
      </button>
    </div>
  );
}

function BookingPanel({ id, rows, courseId, canManage, canFinance, onChanged, onClose }: {
  id: string; rows: SheetRow[]; courseId: string; canManage: boolean; canFinance: boolean; onChanged: (id?: string) => void; onClose: () => void;
}) {
  const [b, setB] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [target, setTarget] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get(`/api/bookings/${id}`).then((r) => setB(r.booking)).catch((e) => setError(e.message));
    get(`/api/bookings/${id}/history`).then((r) => setHistory(r.history)).catch(() => undefined);
  }, [id]);

  async function run(fn: () => Promise<unknown>, keepOpen = true) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged(keepOpen ? id : undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!b) return <div className="card"><ErrorBox error={error} /></div>;
  const row = rows.find((r) => r.teeTimeId === b.teeTime.id);
  const others = row?.bookings.filter((x) => x.id !== b.id) ?? [];
  const maxPlayers = Math.min(4, (row?.maxPlayers ?? 4) - (row?.bookedPlayers ?? b.players) + b.players);

  // Départs du jour où la réservation peut aller (vide, ou réunion compatible).
  const targets = rows.filter((r) => r.teeTimeId !== b.teeTime.id && r.inGrid && (
    r.bookedPlayers === 0
      ? r.allowedHoles.includes(b.holes)
      : !b.isPrivate && !r.isPrivate && r.holes === b.holes && r.remaining >= b.players
  ));

  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>{b.reference}</h2>
        <button className="btn sm" onClick={onClose}>✕</button>
      </div>
      <div>
        <strong>{b.teeTime.localTime}</strong> · {b.players} joueur(s) · {b.holes} trous · {CHANNEL_LABEL[b.channel]}
        {b.isPrivate && <span className="badge private"> Privé</span>}
        {b.status === 'cancelled' && <span className="badge warn"> Annulée</span>}
        {b.groupId && <span className="badge"> Groupe</span>}
      </div>
      {row?.bookings.find((x) => x.id === b.id)?.customerName && (
        <div className="small">Golfeur : <strong>{row.bookings.find((x) => x.id === b.id)!.customerName}</strong>
          {row.bookings.find((x) => x.id === b.id)!.customerPhone && ` · ${row.bookings.find((x) => x.id === b.id)!.customerPhone}`}</div>
      )}
      {others.length > 0 && <div className="small muted">Partage le départ avec : {others.map((o) => `${o.customerName ?? o.reference} (${o.players} j)`).join(', ')}</div>}
      {b.notes && <div className="small">📝 {b.notes}</div>}
      {b.status === 'confirmed' && <QuoteLines quote={{ ...b.pricing, lines: b.pricing.lines }} />}
      <PaymentSection key={b.status + b.pricing.totalMinor} bookingId={id} canManage={canManage} canFinance={canFinance} onChanged={() => onChanged(id)} />

      {canManage && b.status === 'confirmed' && (
        <>
          <h3>Accueil</h3>
          <div className="row">
            {([['arrived', 'Arrivé'], ['no_show', 'Absent'], ['expected', 'Attendu']] as const).map(([st, label]) => (
              <button key={st} className={`btn sm ${row?.bookings.find((x) => x.id === b.id)?.checkinStatus === st ? 'primary' : ''}`} disabled={busy}
                onClick={() => run(() => put(`/api/bookings/${id}/checkin`, { status: st }))}>{label}</button>
            ))}
          </div>
          <h3>Modifier</h3>
          <div className="grid2">
            <label>Joueurs<select value={b.players} disabled={busy}
              onChange={(e) => run(() => patch(`/api/bookings/${id}`, { players: Number(e.target.value) }))}>
              {Array.from({ length: maxPlayers }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}</select></label>
            <label>Caddie<select value={b.caddiePayment} disabled={busy}
              onChange={(e) => run(() => patch(`/api/bookings/${id}`, { caddiePayment: e.target.value }))}>
              <option value="on_site">payé sur place</option><option value="with_booking">payé avec la réservation</option></select></label>
          </div>
          <h3>Déplacer ou réunir</h3>
          <div className="row">
            <select value={target} onChange={(e) => setTarget(e.target.value)} style={{ flex: 1 }}>
              <option value="">Choisir un départ…</option>
              {targets.map((r) => (
                <option key={r.startsAt} value={r.startsAt}>
                  {r.localTime} — {r.bookedPlayers === 0 ? 'libre' : `réunir avec ${r.bookings.map((x) => x.customerName ?? x.reference).join(', ')} (${r.bookedPlayers} j)`}
                </option>
              ))}
            </select>
            <button className="btn" disabled={!target || busy} onClick={() => run(() => {
              const r = rows.find((x) => x.startsAt === target)!;
              return post(`/api/bookings/${id}/move`, r.teeTimeId ? { teeTimeId: r.teeTimeId } : { courseId, startsAt: r.startsAt });
            })}>Valider</button>
          </div>
          <CancelControl bookingId={id} onCancelled={() => onChanged(id)} />
        </>
      )}
      <ErrorBox error={error} />
      {history.length > 0 && (
        <>
          <h3>Historique</h3>
          <div className="small muted stack" style={{ gap: 4 }}>
            {history.map((h, i) => (
              <div key={i}>{new Date(h.createdAt).toLocaleString('fr-FR')} · {HISTORY_LABEL[h.action] ?? h.action}{h.actorName && ` · ${h.actorName}`}</div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const HISTORY_LABEL: Record<string, string> = {
  'booking.created': 'Création', 'booking.updated': 'Modification', 'booking.moved': 'Déplacement / réunion',
  'booking.cancelled': 'Annulation', 'allocation.units_assigned': 'Matériel attribué',
  'payment.recorded': 'Encaissement', 'refund.recorded': 'Remboursement', 'payment.confirmed': 'Paiement confirmé',
  'payment.failed': 'Paiement échoué',
};


function BlockPanel({ courseId, date, onDone, onClose }: { courseId: string; date: string; onDone: () => void; onClose: () => void }) {
  const [from, setFrom] = useState('08:00');
  const [to, setTo] = useState('10:00');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  async function act(kind: 'block' | 'unblock') {
    setError(null);
    try {
      if (kind === 'block') {
        const r = await post<{ blocked: number; withBookings: number }>(`/api/courses/${courseId}/blocks`, { date, from, to, reason });
        setInfo(`${r.blocked} départ(s) bloqué(s)${r.withBookings ? ` — attention : ${r.withBookings} déjà réservé(s), réservations conservées` : ''}.`);
      } else {
        const r = await post<{ unblocked: number }>(`/api/courses/${courseId}/unblock`, { date, from, to });
        setInfo(`${r.unblocked} départ(s) débloqué(s).`);
      }
      onDone();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>Bloquer des départs</h2>
        <button className="btn sm" onClick={onClose}>✕</button>
      </div>
      <p className="small muted" style={{ margin: 0 }}>Tournoi, entretien, créneau gardé… Les départs bloqués ne sont plus proposés ni réservables. Le {date}.</p>
      <div className="grid2">
        <label>De<input type="time" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>À (inclus)<input type="time" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <label>Motif<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ex. Compétition, entretien du green 1" /></label>
      <ErrorBox error={error} />
      {info && <div className="alert ok">{info}</div>}
      <div className="row">
        <button className="btn primary" disabled={!reason.trim()} onClick={() => act('block')}>Bloquer</button>
        <button className="btn" onClick={() => act('unblock')}>Débloquer la plage</button>
      </div>
    </div>
  );
}
