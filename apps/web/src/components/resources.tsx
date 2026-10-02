// Ressources et historique : composants partagés par la feuille de départs,
// la vue starter, la page Ressources et la page Historique.
// Statuts toujours écrits en toutes lettres (jamais la couleur seule).

import { useEffect, useRef, useState } from 'react';
import { get, patch, put } from '../api';

export type ResourceStatus = 'available' | 'reserved' | 'in_use' | 'unavailable';
export const STATUS: Record<ResourceStatus, { label: string; icon: string; cls: string }> = {
  available: { label: 'Disponible', icon: '✓', cls: 'ok' },
  reserved: { label: 'Réservé', icon: '◷', cls: 'info' },
  in_use: { label: 'En utilisation', icon: '▶', cls: 'warn' },
  unavailable: { label: 'Indisponible', icon: '⛔', cls: 'danger' },
};

export function ResourceStatusBadge({ status }: { status: ResourceStatus }) {
  const s = STATUS[status];
  return <span className={`badge ${s.cls}`}><span aria-hidden>{s.icon}</span> {s.label}</span>;
}

/** « 10 h », « 10 h 12 » à partir de « 10:12 ». */
export function hourLabel(t: string): string {
  const [h, m] = t.split(':');
  return `${Number(h)} h${m && m !== '00' ? ` ${m}` : ''}`;
}

// ------------------------------------------------------------------ Choix avec conflits

export interface PickOption { id: string; label: string; free: boolean; conflict: string | null }

/**
 * Liste de choix dépliée sur place : chaque option affiche son état, les
 * options en conflit sont désactivées AVEC la raison (« Déjà prise 10 h–14 h 45 »).
 * Clavier : Tab / Maj+Tab entre options, Entrée pour choisir, Échap pour fermer.
 */
function Picker({ title, load, selected, max, onPick, onClose }: {
  title: string; load: () => Promise<PickOption[]>; selected: string[]; max: number;
  onPick: (ids: string[]) => Promise<void>; onClose: () => void;
}) {
  const [options, setOptions] = useState<PickOption[] | null>(null);
  const [chosen, setChosen] = useState<string[]>(selected);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { load().then(setOptions).catch((e) => setError(e.message)); }, []);
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus(); }, [options]);

  async function commit(ids: string[]) {
    setBusy(true);
    setError(null);
    try { await onPick(ids); onClose(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  function toggle(id: string) {
    if (max === 1) return commit(selected[0] === id ? [] : [id]);
    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length < max ? [...c, id] : c));
  }
  const free = options?.filter((o) => o.free || selected.includes(o.id)).length ?? 0;
  return (
    <div className="picker" ref={ref} role="group" aria-label={title} onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      <div className="row" style={{ alignItems: 'center' }}>
        <strong className="small">{title}</strong>
        {options && <span className="caption muted">{free} libre(s) sur {options.length}</span>}
        <span className="spacer" />
        <button className="btn sm ghost" onClick={onClose}>Fermer</button>
      </div>
      {!options && !error && <div className="small muted" aria-live="polite">Chargement des disponibilités…</div>}
      {options?.length === 0 && <div className="small muted">Aucun élément enregistré pour ce golf (Configuration).</div>}
      {options && options.length > 0 && (
        <ul className="pick-list">
          {options.map((o) => {
            const isSel = (max === 1 ? selected : chosen).includes(o.id);
            const usable = o.free || isSel;
            return (
              <li key={o.id}>
                <button className={`pick ${isSel ? 'on' : ''}`} disabled={busy || !usable} aria-pressed={isSel} onClick={() => toggle(o.id)}>
                  <span className="pick-label">{isSel && <span aria-hidden>✓ </span>}{o.label}</span>
                  <span className={`pick-state ${usable ? '' : 'conflict'}`}>{isSel ? 'Affecté' : o.free ? 'Libre' : o.conflict}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {error && <div className="alert" role="alert">{error}</div>}
      <div className="row">
        {max > 1 && options && <button className="btn sm primary" disabled={busy} onClick={() => commit(chosen)}>Valider ({chosen.length}/{max})</button>}
        {selected.length > 0 && <button className="btn sm danger" disabled={busy} onClick={() => commit([])}>Retirer l'affectation</button>}
      </div>
    </div>
  );
}

/** Caddie nommé d'un départ (starter). */
export function CaddieAssign({ teeTimeId, reserved, name, canAssign, onChanged }: {
  teeTimeId: string; reserved: boolean; name: string | null; canAssign: boolean; onChanged: (message?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState<string[]>([]);
  if (!reserved) return <span className="badge warn">Caddie non réservé</span>;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row" style={{ alignItems: 'center', gap: 6 }}>
        {name ? <span>Caddie : <strong>{name}</strong></span> : <span className="badge warn">Caddie à nommer</span>}
        {canAssign && !open && <button className="btn sm" onClick={() => setOpen(true)}>{name ? 'Changer' : 'Affecter un caddie'}</button>}
      </div>
      {open && (
        <Picker title="Choisir le caddie" max={1} selected={current}
          load={async () => {
            const r = await get(`/api/tee-times/${teeTimeId}/caddie-options`);
            setCurrent(r.caddieId ? [r.caddieId] : []);
            return r.caddies.map((c: any) => ({ id: c.id, label: c.displayName, free: c.free, conflict: c.conflict }));
          }}
          onPick={async (ids) => { await put(`/api/tee-times/${teeTimeId}/caddie`, { caddieId: ids[0] ?? null }); onChanged(ids[0] ? 'Caddie affecté.' : 'Caddie retiré.'); }}
          onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

/** Numéros affectés à une allocation (voiturette n° 12…) — starter. */
export function UnitsAssign({ allocationId, typeName, quantity, units, canAssign, onChanged }: {
  allocationId: string; typeName: string; quantity: number; units: Array<{ id: string; label: string }>; canAssign: boolean; onChanged: (message?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const missing = quantity - units.length;
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row" style={{ alignItems: 'center', gap: 6 }}>
        {units.map((u) => <span key={u.id} className="badge info">n° {u.label}</span>)}
        {missing > 0 && <span className="caption muted">{missing} n° à affecter</span>}
        {canAssign && !open && <button className="btn sm" onClick={() => setOpen(true)}>{units.length ? 'Changer les n°' : 'Affecter les n°'}</button>}
      </div>
      {open && (
        <Picker title={`${typeName} : choisir ${quantity > 1 ? `${quantity} numéros` : 'le numéro'}`} max={quantity} selected={units.map((u) => u.id)}
          load={async () => (await get(`/api/allocations/${allocationId}/unit-options`)).units}
          onPick={async (ids) => { await put(`/api/allocations/${allocationId}/units`, { unitIds: ids }); onChanged(ids.length ? 'Numéro(s) affecté(s).' : 'Affectation retirée.'); }}
          onClose={() => setOpen(false)} />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Section « Matériel et caddie » d'une réservation

interface OptionAvail { resourceTypeId: string; name: string; kind: string; available: number; free: number; maxPerBooking: number | null; current: number; start: string; end: string }

export function BookingResources({ booking, courseId, timezone, caddie, sharedWith, canBook, canAssign, onChanged }: {
  booking: any; courseId: string; timezone?: string; caddie: { reserved: boolean; name: string | null } | null; sharedWith: string[];
  canBook: boolean; canAssign: boolean; onChanged: (message?: string) => void;
}) {
  const [avail, setAvail] = useState<OptionAvail[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const confirmed = booking.status === 'confirmed';

  useEffect(() => {
    if (!confirmed) return;
    get(`/api/courses/${courseId}/options?startsAt=${encodeURIComponent(booking.teeTime.startsAt)}&holes=${booking.holes}&excludeBookingId=${booking.id}`)
      .then((r) => setAvail(r.options)).catch((e) => setError(e.message));
  }, [booking.id, booking.teeTime.startsAt, booking.holes, booking.options.map((o: any) => o.quantity).join()]);

  const qtyOf = (rt: string) => booking.options.find((o: any) => o.resourceTypeId === rt)?.quantity ?? 0;
  const time = (iso: string) => new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: timezone }).format(new Date(iso));

  async function setQty(rt: string, q: number, name: string) {
    setBusy(true);
    setError(null);
    setSaved(null);
    const options = [...(avail ?? []).map((a) => ({ resourceTypeId: a.resourceTypeId, quantity: a.resourceTypeId === rt ? q : qtyOf(a.resourceTypeId) }))]
      .filter((o) => o.quantity > 0);
    try {
      await patch(`/api/bookings/${booking.id}`, { options });
      const msg = `${name} : ${q} réservé(e)${q > 1 ? 's' : ''}. Disponibilités recalculées.`;
      setSaved(msg);
      onChanged(msg);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="stack" style={{ gap: 8 }} aria-labelledby={`res-${booking.id}`}>
      <h3 id={`res-${booking.id}`} style={{ margin: 0 }}>Caddie et matériel</h3>
      {caddie && (
        <div className="res-line">
          <div>
            <div className="small muted">1 caddie par départ{sharedWith.length ? `, partagé avec ${sharedWith.join(', ')}` : ''}</div>
            {booking.teeTime.id && <CaddieAssign teeTimeId={booking.teeTime.id} reserved={caddie.reserved} name={caddie.name} canAssign={canAssign && confirmed} onChanged={onChanged} />}
          </div>
        </div>
      )}
      {confirmed && !avail && !error && <div className="small muted" aria-live="polite">Chargement des disponibilités…</div>}
      {avail && avail.length === 0 && <div className="small muted">Aucun matériel de location configuré pour ce golf.</div>}
      {avail?.map((a) => {
        const q = qtyOf(a.resourceTypeId);
        const opt = booking.options.find((o: any) => o.resourceTypeId === a.resourceTypeId);
        const left = a.free - q; // stock encore libre sur la période
        const atMax = a.maxPerBooking !== null && q >= a.maxPerBooking;
        return (
          <div key={a.resourceTypeId} className="res-line">
            <div className="stack" style={{ gap: 2, flex: 1 }}>
              <strong>{a.name}</strong>
              <span className={`caption ${left > 0 ? 'muted' : 'conflict-text'}`}>
                {left > 0 ? `${left} encore disponible${left > 1 ? 's' : ''} de ${time(a.start)} à ${time(a.end)}`
                  : `Plus aucun(e) disponible de ${time(a.start)} à ${time(a.end)}`}
                {atMax && left > 0 && ` · maximum ${a.maxPerBooking} par réservation`}
              </span>
              {opt && <UnitsAssign allocationId={opt.allocationId} typeName={a.name} quantity={opt.quantity} units={opt.units} canAssign={canAssign && confirmed} onChanged={onChanged} />}
            </div>
            {canBook && confirmed ? (
              <div className="qty" role="group" aria-label={`Quantité ${a.name}`}>
                <button className="btn sm icon" disabled={busy || q === 0} onClick={() => setQty(a.resourceTypeId, q - 1, a.name)} aria-label={`Retirer un(e) ${a.name}`}>−</button>
                <span className="num" aria-live="polite">{q}</span>
                <button className="btn sm icon" disabled={busy || left <= 0 || atMax} onClick={() => setQty(a.resourceTypeId, q + 1, a.name)}
                  aria-label={`Ajouter un(e) ${a.name}`} title={left <= 0 ? 'Plus aucun disponible sur ce créneau' : atMax ? `Maximum ${a.maxPerBooking} par réservation` : undefined}>+</button>
              </div>
            ) : <span className="num">{q}</span>}
          </div>
        );
      })}
      {!confirmed && booking.options.length === 0 && <div className="small muted">Réservation annulée : caddie et matériel libérés.</div>}
      {saved && <div className="alert ok" role="status">{saved}</div>}
      {error && <div className="alert" role="alert">{error}</div>}
    </section>
  );
}

// ------------------------------------------------------------------ Historique

export interface HistoryEvent {
  id: number; at: string; clubName: string | null; actor: { type: string; name: string }; action: string; category: string;
  reference: string | null; text: string; details: Array<{ label: string; from: string; to: string }>; reason: string | null;
}

const CATEGORY_ICON: Record<string, string> = { bookings: '📋', payments: '💳', resources: '🛺', operations: '⛳', config: '⚙', accounts: '👤', other: '•' };

export function HistoryList({ events, showClub = false, timezone }: { events: HistoryEvent[]; showClub?: boolean; timezone?: string }) {
  const fmt = (iso: string) => new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: timezone }).format(new Date(iso));
  if (!events.length) return <p className="small muted" style={{ margin: 0 }}>Aucun événement enregistré.</p>;
  return (
    <ol className="history">
      {events.map((e) => (
        <li key={e.id}>
          <span className="history-icon" aria-hidden>{CATEGORY_ICON[e.category] ?? '•'}</span>
          <div className="stack" style={{ gap: 2 }}>
            <span>{e.text}</span>
            <span className="caption muted">{fmt(e.at)}{showClub && e.clubName ? ` · ${e.clubName}` : ''}{e.actor.type === 'system' ? ' · automatique' : ''}</span>
            {e.reason && <span className="small">Motif : {e.reason}</span>}
            {e.details.length > 0 && (
              <details>
                <summary className="caption">Détail des changements</summary>
                <table className="lines figures history-details">
                  <thead><tr><th>Champ</th><th>Avant</th><th>Après</th></tr></thead>
                  <tbody>{e.details.map((x) => <tr key={x.label}><td>{x.label}</td><td>{x.from}</td><td>{x.to}</td></tr>)}</tbody>
                </table>
              </details>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
