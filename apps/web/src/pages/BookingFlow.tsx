import { useEffect, useMemo, useState } from 'react';
import { get, post, type User } from '../api';
import { addDays, money, todayIn } from '../format';
import { ErrorBox, useClubs, useCourses } from './common';
import { errorText, useI18n } from '../i18n';

interface Slot { startsAt: string; localTime: string; remaining: number; canBePrivate: boolean }
interface Option { resourceTypeId: string; code: string; name: string; unitPriceMinor: number; currency: string; available: number }
interface Quote { currency: string; totalMinor: number; dueWithBookingMinor: number; dueOnSiteMinor: number;
  lines: Array<{ kind?: string; label: string; quantity: number; totalMinor: number; payable: string }> }

export function BookingFlow({ user, onDone }: { user: User | null; onDone: () => void }) {
  const clubs = useClubs(null);
  const [clubId, setClubId] = useState<string | null>(null);
  const courses = useCourses(clubId);
  const [courseId, setCourseId] = useState<string | null>(null);
  const club = clubs.find((c) => c.id === clubId);
  const course = courses.find((c) => c.id === courseId);
  const [date, setDate] = useState('');
  const [holes, setHoles] = useState<9 | 18>(18);
  const [players, setPlayers] = useState(2);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [options, setOptions] = useState<Option[]>([]);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [isPrivate, setIsPrivate] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [openNote, setOpenNote] = useState('');
  const [membership, setMembership] = useState<{ planName: string } | null>(null);
  const [caddiePayment, setCaddiePayment] = useState<'on_site' | 'with_booking'>('on_site');
  const [contact, setContact] = useState({ firstName: '', lastName: '', email: '', phone: '' });
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ reference: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const { t, locale } = useI18n();

  useEffect(() => { if (!clubId && clubs[0]) setClubId(clubs[0].id); }, [clubs]);
  useEffect(() => { setCourseId(courses[0]?.id ?? null); }, [courses]);
  useEffect(() => { if (club && !date) setDate(addDays(todayIn(club.timezone), 1)); }, [club]);
  useEffect(() => { if (course && !course.allowedHoles.includes(holes)) setHoles(course.allowedHoles[0] as 9 | 18); }, [course]);

  // Créneaux
  useEffect(() => {
    setSlot(null);
    setSlots(null);
    if (!courseId || !date) return;
    get<{ slots: Slot[]; membership: { planName: string } | null }>(`/api/courses/${courseId}/availability?date=${date}&players=${players}&holes=${holes}`)
      .then((r) => { setSlots(r.slots); setMembership(r.membership ?? null); })
      .catch((e) => setError(errorText(t, e)));
  }, [courseId, date, holes, players, reload]);

  // Options du créneau choisi
  useEffect(() => {
    setQty({});
    setIsPrivate(false);
    if (!slot || !courseId) return setOptions([]);
    get<{ options: Option[] }>(`/api/courses/${courseId}/options?startsAt=${encodeURIComponent(slot.startsAt)}&holes=${holes}`)
      .then((r) => setOptions(r.options));
  }, [slot]);

  const optionList = useMemo(
    () => Object.entries(qty).filter(([, q]) => q > 0).map(([resourceTypeId, quantity]) => ({ resourceTypeId, quantity })),
    [qty],
  );

  // Devis
  useEffect(() => {
    setQuote(null);
    if (!slot || !courseId) return;
    post<{ quote: Quote }>('/api/quote', { courseId, startsAt: slot.startsAt, players, holes, isPrivate, caddiePayment, options: optionList })
      .then((r) => setQuote(r.quote))
      .catch((e) => setError(errorText(t, e)));
  }, [slot, isPrivate, caddiePayment, optionList]);

  async function confirm() {
    if (!slot || !courseId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ booking: { reference: string } }>(
        '/api/bookings',
        {
          courseId, startsAt: slot.startsAt, players, holes, isPrivate, caddiePayment, options: optionList,
          isOpen: !!user && isOpen && !isPrivate, openNote: isOpen ? openNote || null : null,
          ...(user?.customerId ? {} : {
            customer: { firstName: contact.firstName || null, lastName: contact.lastName, email: contact.email || null, phone: contact.phone || null, preferredLocale: locale },
          }),
        },
        { 'Idempotency-Key': crypto.randomUUID() },
      );
      setDone(r.booking);
    } catch (e) {
      setError(errorText(t, e));
      // Le créneau a pu être pris entre-temps : on rafraîchit la liste.
      setReload((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="card stack" style={{ maxWidth: 560 }}>
        <h1>{t('book.done')}</h1>
        <p>{t('book.doneText', { ref: done.reference, golf: club?.name ?? '', date, time: slot?.localTime ?? '', players, holes })}</p>
        {quote && <p>{t('book.toPay', { amount: money(quote.dueWithBookingMinor, quote.currency) })}{quote.dueOnSiteMinor > 0 && <> · {t('book.toPayOnSite', { amount: money(quote.dueOnSiteMinor, quote.currency) })}</>}</p>}
        <div className="row">
          <button className="btn primary" onClick={() => { setDone(null); setSlot(null); setReload((n) => n + 1); onDone(); }}>{t('book.finish')}</button>
        </div>
      </div>
    );
  }

  // Libellés générés par le serveur (caddie) traduits ; les autres sont ceux configurés par le golf.
  const lineLabel = (l: { kind?: string; label: string }) =>
    l.kind === 'caddie' ? t(l.label.includes('—') ? 'line.caddieShared' : 'line.caddie', { holes }) : l.label;

  const contactOk = !!user?.customerId || (contact.lastName.trim() && (contact.email.trim() || contact.phone.trim()));

  return (
    <div className="steps">
      <h1>{t('book.title')}</h1>
      <div className="card grid2">
        <label>{t('book.golf')}
          <select value={clubId ?? ''} onChange={(e) => { setClubId(e.target.value); setDate(''); }}>
            {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        {courses.length > 1 && (
          <label>{t('book.course')}
            <select value={courseId ?? ''} onChange={(e) => setCourseId(e.target.value)}>
              {courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}
        <label>{t('book.date')}<input type="date" value={date} min={club ? todayIn(club.timezone) : undefined} onChange={(e) => setDate(e.target.value)} /></label>
        <label>{t('book.holes')}
          <select value={holes} onChange={(e) => setHoles(Number(e.target.value) as 9 | 18)}>
            {(course?.allowedHoles ?? [9, 18]).map((h) => <option key={h} value={h}>{t('book.holesN', { n: h })}</option>)}
          </select>
        </label>
        <label>{t('book.players')}
          <select value={players} onChange={(e) => setPlayers(Number(e.target.value))}>
            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>

      <div className="card">
        <h2>{t('book.slots')}</h2>
        {slots === null ? <p className="muted">{t('book.loading')}</p> : slots.length === 0 ? <p className="muted">{t('book.noSlots', { n: players })}</p> : (
          <div className="slots">
            {slots.map((s) => (
              <button key={s.startsAt} className={`slot-btn ${slot?.startsAt === s.startsAt ? 'active' : ''}`} onClick={() => setSlot(s)}>
                {s.localTime}<small>{t('book.seats', { n: s.remaining })}</small>
              </button>
            ))}
          </div>
        )}
      </div>

      {slot && (
        <div className="card stack">
          <h2>{t('book.options')}</h2>
          <div className="grid2">
            {options.map((o) => (
              <label key={o.resourceTypeId}>
                {o.name} — {money(o.unitPriceMinor, o.currency)}
                <select value={qty[o.resourceTypeId] ?? 0} onChange={(e) => setQty({ ...qty, [o.resourceTypeId]: Number(e.target.value) })} disabled={o.available === 0}>
                  {Array.from({ length: Math.min(o.available, 4) + 1 }, (_, i) => <option key={i} value={i}>{i}</option>)}
                </select>
                {o.available === 0 && <span className="badge warn">{t('book.unavailable')}</span>}
              </label>
            ))}
          </div>
          {slot.canBePrivate && (
            <label className="check"><input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} />
              {t('book.private')}</label>
          )}
          {user && !isPrivate && players < 4 && <>
            <label className="check"><input type="checkbox" checked={isOpen} onChange={(e) => setIsOpen(e.target.checked)} /> {t('book.open')}</label>
            {isOpen && <input placeholder={t('mine.openNote')} value={openNote} maxLength={200} onChange={(e) => setOpenNote(e.target.value)} />}
          </>}
          {membership && <div><span className="badge ok">{t('book.member', { plan: membership.planName })}</span></div>}
          <div>
            <div className="small muted">{t('book.caddie')}</div>
            <label className="check"><input type="radio" checked={caddiePayment === 'on_site'} onChange={() => setCaddiePayment('on_site')} /> {t('book.caddieOnSite')}</label>
            <label className="check"><input type="radio" checked={caddiePayment === 'with_booking'} onChange={() => setCaddiePayment('with_booking')} /> {t('book.caddieWithBooking')}</label>
          </div>
        </div>
      )}

      {slot && !user?.customerId && (
        <div className="card stack">
          <h2>{t('book.contact')}</h2>
          <div className="grid2">
            <label>{t('book.firstName')}<input value={contact.firstName} onChange={(e) => setContact({ ...contact, firstName: e.target.value })} autoComplete="given-name" /></label>
            <label>{t('book.lastName')}<input value={contact.lastName} onChange={(e) => setContact({ ...contact, lastName: e.target.value })} autoComplete="family-name" /></label>
            <label>{t('book.email')}<input type="email" value={contact.email} onChange={(e) => setContact({ ...contact, email: e.target.value })} autoComplete="email" /></label>
            <label>{t('book.phone')}<input type="tel" value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} autoComplete="tel" /></label>
          </div>
          <p className="small muted">{t('book.contactHint')}</p>
        </div>
      )}

      {slot && quote && (
        <div className="card stack">
          <h2>{t('book.summary')}</h2>
          <table className="lines"><tbody>
            {quote.lines.map((l, i) => (
              <tr key={i}><td>{lineLabel(l)}{l.quantity > 1 && ` × ${l.quantity}`}{l.payable === 'on_site' && <span className="badge"> {t('book.onSite')}</span>}</td><td>{money(l.totalMinor, quote.currency)}</td></tr>
            ))}
            <tr className="total"><td>{t('book.total')}</td><td>{money(quote.totalMinor, quote.currency)}</td></tr>
            {quote.dueOnSiteMinor > 0 && <tr><td className="muted">{t('book.dueOnSite')}</td><td className="muted">{money(quote.dueOnSiteMinor, quote.currency)}</td></tr>}
          </tbody></table>
          <p className="small muted">{t('book.payAtGolf')}</p>
          <ErrorBox error={error} />
          <button className="btn primary" disabled={busy || !contactOk} onClick={confirm}>{t('book.confirm')}</button>
        </div>
      )}
      {!slot && <ErrorBox error={error} />}
    </div>
  );
}
