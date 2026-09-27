// Composants d'interface du thème : créneaux, légende, stepper, calendrier,
// badges de statut, sélecteur de joueurs, modale de confirmation.
// Aucune couleur ici : tout passe par les classes de styles.css (tokens).

import { useEffect, type ReactNode } from 'react';
import { useI18n } from '../i18n';

// ------------------------------------------------------------------ Créneau
export interface TeeSlotData {
  startsAt: string; localTime: string; remaining: number;
  state?: 'available' | 'full' | 'blocked'; reason?: string | null; membersOnly?: boolean; discountPercent?: number | null;
}

/** Créneau : disponible, presque complet, sélectionné, complet, bloqué, membres, tarif réduit. */
export function TeeSlot({ slot, players, selected, onSelect }: { slot: TeeSlotData; players: number; selected: boolean; onSelect: () => void }) {
  const { t } = useI18n();
  const state = slot.state ?? 'available';
  const disabled = state !== 'available';
  const few = !disabled && slot.remaining <= 2;
  const cls = ['tee-slot', selected && 'selected', state === 'full' && 'full', state === 'blocked' && 'blocked', few && !selected && 'few',
    slot.membersOnly && 'members'].filter(Boolean).join(' ');
  const sub = state === 'blocked' ? (slot.reason || t('slot.blocked'))
    : state === 'full' ? (slot.remaining > 0 && slot.remaining < players ? t('slot.short', { n: slot.remaining }) : t('slot.full'))
    : few ? t('slot.few', { n: slot.remaining }) : t('slot.places', { n: slot.remaining });
  return (
    <button type="button" className={cls} aria-disabled={disabled || undefined} aria-pressed={selected}
      onClick={() => !disabled && onSelect()}
      aria-label={`${slot.localTime}, ${sub}${slot.membersOnly ? `, ${t('slot.members')}` : ''}${slot.discountPercent ? `, −${slot.discountPercent} %` : ''}`}>
      {!!slot.discountPercent && !disabled && <span className="deal">−{slot.discountPercent} %</span>}
      <span className="t">{slot.localTime}</span>
      <span className="sub">{sub}</span>
      {slot.membersOnly && <span className="members-tag">{t('slot.members')}</span>}
    </button>
  );
}

export function SlotLegend() {
  const { t } = useI18n();
  return (
    <div className="slot-legend" aria-hidden>
      <span><i /> {t('slot.available')}</span>
      <span><i className="few" /> {t('slot.fewLegend')}</span>
      <span><i className="sel" /> ✓ {t('slot.selected')}</span>
      <span><i className="full" /> <s>{t('slot.full')}</s></span>
      <span><i className="blocked" /> {t('slot.blocked')}</span>
      <span><i className="members" /> ★ {t('slot.members')}</span>
      <span><span className="badge success">−%</span> {t('slot.deal')}</span>
    </div>
  );
}

// ------------------------------------------------------------------ Stepper
export function Stepper({ steps, current, onGo }: { steps: string[]; current: number; onGo?: (i: number) => void }) {
  return (
    <ol className="stepper">
      {steps.map((label, i) => {
        const state = i < current ? 'done' : i === current ? 'active' : 'todo';
        const content = <><span className="dot">{i < current ? '✓' : i + 1}</span><span className="label">{label}</span></>;
        return (
          <li key={label} className={state} aria-current={i === current ? 'step' : undefined}>
            {i < current && onGo ? <button type="button" onClick={() => onGo(i)}>{content}</button> : content}
          </li>
        );
      })}
    </ol>
  );
}

// ------------------------------------------------------------------ Calendrier
export interface CalendarDay { date: string; available: number; deal: boolean }

export function Calendar({ month, onMonth, days, selected, today, onSelect, locale }: {
  month: string; onMonth: (m: string) => void; days: Map<string, CalendarDay>; selected: string; today: string;
  onSelect: (d: string) => void; locale: string;
}) {
  const { t } = useI18n();
  const first = new Date(`${month}-01T12:00:00Z`);
  const offset = (first.getUTCDay() + 6) % 7; // lundi en premier
  const count = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  const shift = (n: number) => { const d = new Date(first); d.setUTCMonth(d.getUTCMonth() + n); onMonth(d.toISOString().slice(0, 7)); };
  const dow = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(locale, { weekday: 'narrow', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 1 + i))));
  const title = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(first);
  const long = (d: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`));
  return (
    <div>
      <div className="cal-head">
        <button type="button" className="btn ghost icon" onClick={() => shift(-1)} disabled={month <= today.slice(0, 7)} aria-label={t('book.prevMonth')}>‹</button>
        <strong>{title}</strong>
        <button type="button" className="btn ghost icon" onClick={() => shift(1)} aria-label={t('book.nextMonth')}>›</button>
      </div>
      <div className="calendar" role="grid">
        {dow.map((d, i) => <div key={i} className="dow">{d}</div>)}
        {Array.from({ length: offset }, (_, i) => <div key={`e${i}`} />)}
        {Array.from({ length: count }, (_, i) => {
          const date = `${month}-${String(i + 1).padStart(2, '0')}`;
          const info = days.get(date);
          const bookable = !!info && info.available > 0;
          const cls = ['day', date === today && 'today', date === selected && 'selected', info && !bookable && 'full', bookable && info.deal && 'deal'].filter(Boolean).join(' ');
          return (
            <button key={date} type="button" className={cls} disabled={!bookable} onClick={() => onSelect(date)} aria-pressed={date === selected}
              aria-label={`${long(date)}${info && !bookable ? `, ${t('slot.full')}` : ''}${bookable && info!.deal ? `, ${t('book.dealDay')}` : ''}`}>
              {i + 1}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Badges de statut
export type BookingStatus = 'confirmed' | 'pending' | 'cancelled' | 'done';
export function StatusBadge({ status }: { status: BookingStatus }) {
  const { t } = useI18n();
  const map: Record<BookingStatus, [string, string]> = {
    confirmed: ['success', '✓'], pending: ['warn', '⏱'], cancelled: ['danger', '✕'], done: ['', '●'],
  };
  const [cls, icon] = map[status];
  return <span className={`badge ${cls}`}><span aria-hidden>{icon}</span>{t(`status.${status}` as never)}</span>;
}

// ------------------------------------------------------------------ Joueurs −/+
export function PlayersStepper({ value, min = 1, max = 4, onChange }: { value: number; min?: number; max?: number; onChange: (n: number) => void }) {
  const { t } = useI18n();
  return (
    <div className="stepper-count" role="group" aria-label={t('book.players')}>
      <button type="button" className="btn sm icon" onClick={() => onChange(value - 1)} disabled={value <= min} aria-label={t('book.fewer')}>−</button>
      <output aria-live="polite">{value}</output>
      <button type="button" className="btn sm icon" onClick={() => onChange(value + 1)} disabled={value >= max} aria-label={t('book.more')}>+</button>
    </div>
  );
}

// ------------------------------------------------------------------ Modale de confirmation
export function ConfirmDialog({ title, children, confirmLabel, cancelLabel, danger, onConfirm, onClose }: {
  title: string; children?: ReactNode; confirmLabel: string; cancelLabel: string; danger?: boolean; onConfirm: () => void; onClose: () => void;
}) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []);
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal stack" role="alertdialog" aria-modal="true" aria-labelledby="modal-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="modal-title">{title}</h2>
        {children}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn" onClick={onClose} autoFocus>{cancelLabel}</button>
          <button type="button" className={`btn ${danger ? 'danger-solid' : 'primary'}`} onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
