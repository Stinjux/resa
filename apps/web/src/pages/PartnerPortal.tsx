// Portail des partenaires (tour-opérateurs, agences) : disponibilités avec
// leurs allotements, réservation à leurs tarifs, suivi et annulation.

import { useEffect, useState } from 'react';
import { get, post, type User } from '../api';
import { addDays, money, todayIn } from '../format';
import { errorText, useI18n } from '../i18n';
import { ErrorBox, useClubs, useCourses } from './common';

export function PartnerPortal({ user }: { user: User }) {
  const { t } = useI18n();
  const clubs = useClubs(user);
  const [clubId, setClubId] = useState<string | null>(null);
  const club = clubs.find((c) => c.id === clubId);
  const courses = useCourses(clubId);
  const [courseId, setCourseId] = useState<string | null>(null);
  const [date, setDate] = useState('');
  const [players, setPlayers] = useState(4);
  const [holes, setHoles] = useState(18);
  const [slots, setSlots] = useState<any[] | null>(null);
  const [slot, setSlot] = useState<any>(null);
  const [quote, setQuote] = useState<any>(null);
  const [form, setForm] = useState({ voucher: '', lead: '', names: '', notes: '' });
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);

  useEffect(() => { if (!clubId && clubs[0]) setClubId(clubs[0].id); }, [clubs]);
  useEffect(() => { setCourseId(courses[0]?.id ?? null); }, [courses]);
  useEffect(() => { if (club && !date) setDate(addDays(todayIn(club.timezone), 1)); }, [club]);
  const course = courses.find((c) => c.id === courseId);
  useEffect(() => { if (course && !course.allowedHoles.includes(holes)) setHoles(course.allowedHoles[0]!); }, [course]);

  useEffect(() => {
    setSlot(null);
    setSlots(null);
    if (!courseId || !date) return;
    get(`/api/partner/availability?courseId=${courseId}&date=${date}&players=${players}&holes=${holes}`)
      .then((r) => setSlots(r.slots)).catch((e) => setError(errorText(t, e)));
  }, [courseId, date, players, holes, version]);

  useEffect(() => {
    setQuote(null);
    if (!slot) return;
    post('/api/partner/quote', { courseId, startsAt: slot.startsAt, players, holes }).then((r) => setQuote(r.quote)).catch((e) => setError(errorText(t, e)));
  }, [slot]);

  async function book() {
    setBusy(true);
    setError(null);
    try {
      const names = form.names.split('\n').map((n) => n.trim()).filter(Boolean).slice(0, players);
      const r = await post('/api/partner/bookings', {
        courseId, startsAt: slot.startsAt, players, holes, partnerReference: form.voucher, leadName: form.lead,
        playerNames: names.length ? names : undefined, notes: form.notes || null,
      }, { 'Idempotency-Key': crypto.randomUUID() });
      setMessage(t('pt.booked', { ref: r.booking.reference }));
      setForm({ voucher: '', lead: '', names: '', notes: '' });
      setSlot(null);
      setVersion((v) => v + 1);
    } catch (e) {
      setError(errorText(t, e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack">
      <div className="card stack">
        <h2 style={{ margin: 0 }}>{t('pt.title')} <span className="badge">{user.partnerName}</span></h2>
        <div className="grid2">
          {clubs.length > 1 && <label>{t('pt.golf')}<select value={clubId ?? ''} onChange={(e) => setClubId(e.target.value)}>
            {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
          {courses.length > 1 && <label>{t('pt.course')}<select value={courseId ?? ''} onChange={(e) => setCourseId(e.target.value)}>
            {courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
          <label>{t('pt.date')}<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label>{t('pt.players')}<select value={players} onChange={(e) => setPlayers(Number(e.target.value))}>
            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>
          <label>{t('pt.holes')}<select value={holes} onChange={(e) => setHoles(Number(e.target.value))}>
            {(course?.allowedHoles ?? [18]).map((h) => <option key={h} value={h}>{h}</option>)}</select></label>
        </div>
        {message && <div className="alert ok">{message}</div>}
        <ErrorBox error={error} />
        <div className="slots">
          {slots?.map((s) => (
            <button key={s.startsAt} className={`slot-btn ${slot?.startsAt === s.startsAt ? 'active' : ''}`} onClick={() => { setSlot(s); setMessage(null); }}>
              <strong>{s.localTime}</strong>
              <div className="small">{t('pt.seats', { n: s.remaining })}</div>
              {s.heldForPartner && <div><span className="badge ok">{t('pt.allotment')}</span></div>}
            </button>
          ))}
          {slots?.length === 0 && <div className="muted">{t('pt.noSlot')}</div>}
        </div>
        {slot && (
          <div className="card stack" style={{ background: 'var(--color-surface-muted)' }}>
            <strong>{date} · {slot.localTime} · {players} × {holes}</strong>
            <div className="grid2">
              <label>{t('pt.voucher')}<input value={form.voucher} onChange={(e) => setForm({ ...form, voucher: e.target.value })} /></label>
              <label>{t('pt.lead')}<input value={form.lead} onChange={(e) => setForm({ ...form, lead: e.target.value })} /></label>
            </div>
            <label>{t('pt.names')}<textarea rows={Math.min(players, 4)} value={form.names} onChange={(e) => setForm({ ...form, names: e.target.value })} /></label>
            <label>{t('pt.notes')}<input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
            {quote && <div>{t('pt.total')} : <strong>{money(quote.totalMinor, quote.currency)}</strong></div>}
            <div className="row">
              <button className="btn primary" disabled={busy || !quote || !form.voucher.trim() || !form.lead.trim()} onClick={book}>{t('pt.book')}</button>
            </div>
          </div>
        )}
      </div>
      {club && <MyPartnerBookings timezone={club.timezone} version={version} onChanged={() => setVersion((v) => v + 1)} />}
    </div>
  );
}

function MyPartnerBookings({ timezone, version, onChanged }: { timezone: string; version: number; onChanged: () => void }) {
  const { t } = useI18n();
  const today = todayIn(timezone);
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(addDays(today, 60));
  const [list, setList] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (from && to) get(`/api/partner/bookings?from=${from}&to=${to}`).then((r) => setList(r.bookings)).catch((e) => setError(errorText(t, e)));
  }, [from, to, version]);

  async function cancel(id: string) {
    if (!window.confirm(t('pt.cancelConfirm'))) return;
    try { await post(`/api/partner/bookings/${id}/cancel`); onChanged(); } catch (e) { setError(errorText(t, e)); }
  }

  return (
    <div className="card stack">
      <div className="row">
        <h2 style={{ margin: 0 }}>{t('pt.myBookings')}</h2>
        <span className="spacer" />
        <label className="row small">{t('pt.from')}<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="row small">{t('pt.to')}<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <ErrorBox error={error} />
      <div className="table-wrap"><table className="sheet">
        <thead><tr><th>{t('pt.date')}</th><th>{t('pt.golf')}</th><th>Ref.</th><th>{t('pt.voucher')}</th><th>{t('pt.lead')}</th><th>{t('pt.players')}</th><th /><th>{t('pt.balance')}</th><th /></tr></thead>
        <tbody>
          {list.map((b) => (
            <tr key={b.id} className={b.status === 'cancelled' ? 'muted' : ''}>
              <td>{new Date(b.startsAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short', timeZone: b.timezone })}</td>
              <td className="small">{b.clubName} · {b.courseName}</td><td>{b.reference}</td><td>{b.partnerReference}</td><td>{b.leadName}</td>
              <td>{b.players} × {b.holes}</td>
              <td><span className={b.status === 'cancelled' ? 'badge warn' : 'badge ok'}>{t(`pt.status.${b.status}` as never)}</span></td>
              <td>{money(b.balanceMinor, b.currency ?? 'MAD')}</td>
              <td>{b.status === 'confirmed' && new Date(b.startsAt) > new Date() && <button className="btn sm danger" onClick={() => cancel(b.id)}>{t('pt.cancel')}</button>}</td>
            </tr>
          ))}
          {list.length === 0 && <tr><td colSpan={9} className="muted">{t('pt.none')}</td></tr>}
        </tbody>
      </table></div>
    </div>
  );
}
