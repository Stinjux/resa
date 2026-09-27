// Tunnel de réservation client : Date → Créneau → Joueurs → Paiement.
// Une seule action primaire à la fois (dans la barre de récapitulatif).

import { useEffect, useMemo, useState } from 'react';
import { get, post, type User } from '../api';
import { money, todayIn } from '../format';
import { ErrorBox, useClubs, useCourses } from './common';
import { currentIntl, errorText, useI18n } from '../i18n';
import { Calendar, PlayersStepper, SlotLegend, Stepper, TeeSlot, type CalendarDay, type TeeSlotData } from '../components/ui';

interface Slot extends TeeSlotData { canBePrivate: boolean }
interface Option { resourceTypeId: string; code: string; name: string; unitPriceMinor: number; currency: string; available: number }
interface Quote { currency: string; totalMinor: number; dueWithBookingMinor: number; dueOnSiteMinor: number;
  lines: Array<{ kind?: string; label: string; quantity: number; totalMinor: number; payable: string }> }

const STEP = { date: 0, slot: 1, players: 2, payment: 3 } as const;

export function BookingFlow({ user, onDone }: { user: User | null; onDone: () => void }) {
  const clubs = useClubs(null);
  const [clubId, setClubId] = useState<string | null>(null);
  const courses = useCourses(clubId);
  const [courseId, setCourseId] = useState<string | null>(null);
  const club = clubs.find((c) => c.id === clubId);
  const course = courses.find((c) => c.id === courseId);
  const [step, setStep] = useState(0);
  const [date, setDate] = useState('');
  const [month, setMonth] = useState('');
  const [calendar, setCalendar] = useState<Map<string, CalendarDay>>(new Map());
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
  const [touched, setTouched] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ reference: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const { t, locale } = useI18n();
  const intl = currentIntl();
  const today = club ? todayIn(club.timezone) : '';

  useEffect(() => { if (!clubId && clubs[0]) setClubId(clubs[0].id); }, [clubs]);
  useEffect(() => { setCourseId(courses[0]?.id ?? null); }, [courses]);
  useEffect(() => { if (club) { setMonth(todayIn(club.timezone).slice(0, 7)); setDate(''); setStep(STEP.date); } }, [club]);
  useEffect(() => { if (course && !course.allowedHoles.includes(holes)) setHoles(course.allowedHoles[0] as 9 | 18); }, [course]);

  // Calendrier : jours réservables et jours à tarif réduit.
  useEffect(() => {
    if (!courseId || !today) return;
    get<{ days: CalendarDay[] }>(`/api/courses/${courseId}/calendar?from=${today}&days=62&players=${players}&holes=${holes}`)
      .then((r) => setCalendar(new Map(r.days.map((d) => [d.date, d])))).catch((e) => setError(errorText(t, e)));
  }, [courseId, today, holes, players]);

  // Créneaux (grille complète : disponibles, complets, bloqués)
  useEffect(() => {
    setSlots(null);
    if (!courseId || !date) return;
    get<{ slots: Slot[]; membership: { planName: string } | null }>(`/api/courses/${courseId}/availability?date=${date}&players=${players}&holes=${holes}&all=1`)
      .then((r) => {
        setSlots(r.slots);
        setMembership(r.membership ?? null);
        // Le créneau choisi ne convient plus (joueurs ajoutés, pris entre-temps) : on le retire.
        setSlot((cur) => (cur && r.slots.some((s) => s.startsAt === cur.startsAt && s.state === 'available') ? cur : null));
      })
      .catch((e) => setError(errorText(t, e)));
  }, [courseId, date, holes, players, reload]);

  useEffect(() => {
    setQty({});
    setIsPrivate(false);
    if (!slot || !courseId) return setOptions([]);
    get<{ options: Option[] }>(`/api/courses/${courseId}/options?startsAt=${encodeURIComponent(slot.startsAt)}&holes=${holes}`)
      .then((r) => setOptions(r.options));
  }, [slot?.startsAt]);

  const optionList = useMemo(
    () => Object.entries(qty).filter(([, q]) => q > 0).map(([resourceTypeId, quantity]) => ({ resourceTypeId, quantity })),
    [qty],
  );

  useEffect(() => {
    setQuote(null);
    if (!slot || !courseId) return;
    post<{ quote: Quote }>('/api/quote', { courseId, startsAt: slot.startsAt, players, holes, isPrivate, caddiePayment, options: optionList })
      .then((r) => setQuote(r.quote))
      .catch((e) => setError(errorText(t, e)));
  }, [slot?.startsAt, players, isPrivate, caddiePayment, optionList]);

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
      setReload((n) => n + 1); // le créneau a pu être pris entre-temps
      setStep(STEP.slot);
    } finally {
      setBusy(false);
    }
  }

  const longDate = (d: string) => d && new Intl.DateTimeFormat(intl, { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));

  if (done) {
    return (
      <div className="card stack golfer">
        <div className="alert ok">{t('book.done')}</div>
        <h1>{t('book.done')}</h1>
        <p>{t('book.doneText', { ref: done.reference, golf: club?.name ?? '', date: longDate(date), time: slot?.localTime ?? '', players, holes })}</p>
        {quote && <p className="num">{t('book.toPay', { amount: money(quote.dueWithBookingMinor, quote.currency) })}{quote.dueOnSiteMinor > 0 && <> · {t('book.toPayOnSite', { amount: money(quote.dueOnSiteMinor, quote.currency) })}</>}</p>}
        <div className="row">
          <button className="btn primary" onClick={() => { setDone(null); setSlot(null); setStep(STEP.date); setReload((n) => n + 1); onDone(); }}>{t('book.finish')}</button>
        </div>
      </div>
    );
  }

  const lineLabel = (l: { kind?: string; label: string }) =>
    l.kind === 'caddie' ? t(l.label.includes('—') ? 'line.caddieShared' : 'line.caddie', { holes }) : l.label;
  const emailInvalid = !!contact.email && !/^\S+@\S+\.\S+$/.test(contact.email);
  const contactOk = !!user?.customerId || (!!contact.lastName.trim() && (!!contact.email.trim() || !!contact.phone.trim()) && !emailInvalid);
  const canContinue = step === STEP.slot ? !!slot && !!quote : step === STEP.players ? contactOk : step === STEP.payment ? !!quote && contactOk : false;

  function next() {
    if (step === STEP.players && !contactOk) { setTouched(true); return; }
    if (step === STEP.payment) return confirm();
    setError(null);
    setStep(step + 1);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const steps = [t('step.date'), t('step.slot'), t('step.players'), t('step.payment')];

  return (
    <div className="steps golfer" style={{ maxWidth: 860 }}>
      <h1>{t('book.title')}</h1>
      <Stepper steps={steps} current={step} onGo={(i) => setStep(i)} />

      {step === STEP.date && (
        <div className="card stack">
          <div className="grid2">
            <label>{t('book.golf')}
              <select value={clubId ?? ''} onChange={(e) => setClubId(e.target.value)}>
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
          </div>
          <div className="row" style={{ alignItems: 'center' }}>
            <span className="small muted">{t('book.holes')}</span>
            <div className="segmented" role="group" aria-label={t('book.holes')}>
              {(course?.allowedHoles ?? [9, 18]).map((h) => (
                <button key={h} type="button" className={holes === h ? 'active' : ''} aria-pressed={holes === h} onClick={() => setHoles(h as 9 | 18)}>
                  {t('book.holesN', { n: h })}</button>
              ))}
            </div>
            <span className="small muted">{t('book.players')}</span>
            <PlayersStepper value={players} onChange={setPlayers} />
          </div>
          {month && <Calendar month={month} onMonth={setMonth} days={calendar} selected={date} today={today} locale={intl}
            onSelect={(d) => { setDate(d); setSlot(null); setStep(STEP.slot); }} />}
          <div className="small muted"><span className="badge success">●</span> {t('book.dealDay')}</div>
          <ErrorBox error={error} />
        </div>
      )}

      {step === STEP.slot && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 8 }}>
            <h2 style={{ textTransform: 'capitalize', margin: 0 }}>{longDate(date)}</h2>
            {membership && <span className="badge member">★ {t('book.member', { plan: membership.planName })}</span>}
          </div>
          <SlotLegend />
          {slots === null ? <p className="muted">{t('book.loading')}</p>
            : !slots.some((s) => s.state === 'available') && slots.length === 0 ? <p className="muted">{t('book.noSlots', { n: players })}</p> : (
              <div className="slots" role="group" aria-label={t('book.slots')}>
                {slots.map((s) => <TeeSlot key={s.startsAt} slot={s} players={players} selected={slot?.startsAt === s.startsAt} onSelect={() => setSlot(s)} />)}
              </div>
            )}
          <ErrorBox error={error} />
        </div>
      )}

      {step === STEP.players && slot && (
        <>
          <div className="card stack">
            <h2>{t('book.options')}</h2>
            <div className="grid2">
              {options.map((o) => (
                <label key={o.resourceTypeId}>
                  <span>{o.name} — <span className="num">{money(o.unitPriceMinor, o.currency)}</span></span>
                  <select value={qty[o.resourceTypeId] ?? 0} onChange={(e) => setQty({ ...qty, [o.resourceTypeId]: Number(e.target.value) })} disabled={o.available === 0}>
                    {Array.from({ length: Math.min(o.available, 4) + 1 }, (_, i) => <option key={i} value={i}>{i}</option>)}
                  </select>
                  {o.available === 0 && <span className="badge warn">⚠ {t('book.unavailable')}</span>}
                </label>
              ))}
            </div>
            {slot.canBePrivate && (
              <label className="check"><input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} /> {t('book.private')}</label>
            )}
            {user && !isPrivate && players < 4 && <>
              <label className="check"><input type="checkbox" checked={isOpen} onChange={(e) => setIsOpen(e.target.checked)} /> {t('book.open')}</label>
              {isOpen && <input placeholder={t('mine.openNote')} value={openNote} maxLength={200} onChange={(e) => setOpenNote(e.target.value)} />}
            </>}
            <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0, gap: 4 }}>
              <legend className="small muted" style={{ padding: 0 }}>{t('book.caddie')}</legend>
              <label className="check"><input type="radio" name="caddie" checked={caddiePayment === 'on_site'} onChange={() => setCaddiePayment('on_site')} /> {t('book.caddieOnSite')}</label>
              <label className="check"><input type="radio" name="caddie" checked={caddiePayment === 'with_booking'} onChange={() => setCaddiePayment('with_booking')} /> {t('book.caddieWithBooking')}</label>
            </fieldset>
          </div>
          {!user?.customerId && (
            <div className="card stack">
              <h2>{t('book.contact')}</h2>
              <div className="grid2">
                <label>{t('book.firstName')}<input value={contact.firstName} onChange={(e) => setContact({ ...contact, firstName: e.target.value })} autoComplete="given-name" /></label>
                <label>{t('book.lastName')} *
                  <input value={contact.lastName} aria-invalid={touched && !contact.lastName.trim()} onChange={(e) => setContact({ ...contact, lastName: e.target.value })} autoComplete="family-name" />
                  {touched && !contact.lastName.trim() && <span className="field-error">{t('book.contactHint')}</span>}
                </label>
                <label>{t('book.email')}
                  <input type="email" value={contact.email} aria-invalid={emailInvalid} onChange={(e) => setContact({ ...contact, email: e.target.value })} autoComplete="email" />
                  {emailInvalid && <span className="field-error">{t('book.email')} ?</span>}
                </label>
                <label>{t('book.phone')}<input type="tel" value={contact.phone} onChange={(e) => setContact({ ...contact, phone: e.target.value })} autoComplete="tel" /></label>
              </div>
              <p className="small muted" style={{ margin: 0 }}>{t('book.contactHint')}</p>
            </div>
          )}
        </>
      )}

      {step === STEP.payment && slot && quote && (
        <div className="card stack">
          <h2>{t('book.summary')}</h2>
          <p className="muted" style={{ margin: 0 }}>{club?.name} · {course?.name} · <span style={{ textTransform: 'capitalize' }}>{longDate(date)}</span> · <span className="num">{slot.localTime}</span></p>
          <table className="lines"><tbody>
            {quote.lines.map((l, i) => (
              <tr key={i}><td>{lineLabel(l)}{l.quantity > 1 && ` × ${l.quantity}`}{l.payable === 'on_site' && <> <span className="badge">{t('book.onSite')}</span></>}</td><td>{money(l.totalMinor, quote.currency)}</td></tr>
            ))}
            <tr className="total"><td>{t('book.total')}</td><td>{money(quote.totalMinor, quote.currency)}</td></tr>
            {quote.dueOnSiteMinor > 0 && <tr><td className="muted">{t('book.dueOnSite')}</td><td className="muted">{money(quote.dueOnSiteMinor, quote.currency)}</td></tr>}
          </tbody></table>
          <p className="small muted" style={{ margin: 0 }}>{t('book.payAtGolf')}</p>
          <ErrorBox error={error} />
        </div>
      )}

      {step > STEP.date && (
        <div className="recap-bar" role="region" aria-label={t('book.summary')}>
          <button type="button" className="btn ghost" onClick={() => setStep(step - 1)}>‹ {t('book.back')}</button>
          <div className="stack" style={{ gap: 0, flex: 1, minWidth: 140 }}>
            <span className="recap-when" style={{ textTransform: 'capitalize' }}>{longDate(date)}{slot && <> · {slot.localTime}</>}</span>
            <span className="small muted">{slot ? t('book.holesN', { n: holes }) : t('book.pickSlot')}</span>
          </div>
          {step === STEP.slot && <PlayersStepper value={players} onChange={setPlayers} />}
          {quote && slot && <span className="recap-total">{money(quote.totalMinor, quote.currency)}</span>}
          <button type="button" className="btn primary" disabled={!canContinue || busy} onClick={next}>
            {step === STEP.payment ? t('book.book') : t('book.continue')}
          </button>
        </div>
      )}
    </div>
  );
}
