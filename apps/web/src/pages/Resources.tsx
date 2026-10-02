// Ressources du golf : disponibilité du jour (voiturettes, chariots, sacs,
// caddies), statut de chaque unité, maintenances et absences, conflits à
// résoudre. Tout le personnel consulte ; le starter affecte ; le gestionnaire
// déclare les maintenances et indisponibilités.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { get, post, type User } from '../api';
import { addDays, longDate, todayIn } from '../format';
import { CaddieAssign, ResourceStatusBadge, STATUS, UnitsAssign, type ResourceStatus } from '../components/resources';
import { ErrorBox, useClubs } from './common';

/** « 2026-10-02T14:30 » (heure du golf) → instant ISO. */
function clubLocalToIso(value: string, tz: string): string {
  const [d, t] = value.split('T');
  const [y, mo, da] = d!.split('-').map(Number);
  const [h, mi] = t!.split(':').map(Number);
  const guess = Date.UTC(y!, mo! - 1, da!, h!, mi!);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const asLocal = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!);
  return new Date(guess - (asLocal - guess)).toISOString();
}
function nowLocalInput(tz: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

type Target = { unitId?: string; caddieId?: string; label: string; kind: 'unit' | 'caddie' };
const REASONS = { unit: ['Panne', 'Entretien', 'Batterie', 'Pneu crevé', 'Nettoyage'], caddie: ['Congé', 'Maladie', 'Formation', 'Absent'] };

export function Resources({ user }: { user: User }) {
  const clubs = useClubs(user, ['org_admin', 'club_admin', 'receptionist', 'starter']);
  const [clubId, setClubId] = useState<string | null>(null);
  const club = clubs.find((c) => c.id === clubId);
  const [date, setDate] = useState('');
  const [board, setBoard] = useState<any>(null);
  const [perms, setPerms] = useState({ manage: false, assign: false, book: false });
  const [tab, setTab] = useState<'equipment' | 'caddies' | 'unavailable'>('equipment');
  const [target, setTarget] = useState<Target | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => { if (!clubId && clubs[0]) setClubId(clubs[0].id); }, [clubs]);
  useEffect(() => { if (club) setDate(todayIn(club.timezone)); }, [club?.id]);
  const load = useCallback(() => {
    if (!clubId || !date) return;
    setLoading(true);
    get(`/api/clubs/${clubId}/resources?date=${date}`)
      .then((r) => { setBoard(r.board); setPerms(r.permissions); setError(null); })
      .catch((e) => { setBoard(null); setError(e.message); })
      .finally(() => setLoading(false));
  }, [clubId, date]);
  useEffect(load, [load]);

  const byType = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const u of board?.units ?? []) m.set(u.typeName, [...(m.get(u.typeName) ?? []), u]);
    return [...m.entries()];
  }, [board]);
  const today = club ? todayIn(club.timezone) : '';

  async function end(id: string, label: string) {
    setError(null);
    try {
      const r = await post(`/api/unavailabilities/${id}/end`);
      setNotice(r.cancelled ? `Indisponibilité prévue de ${label} annulée.` : `${label} remis(e) en service.`);
      load();
    } catch (e) { setError((e as Error).message); }
  }

  return (
    <div className="stack">
      <div className="card row" style={{ alignItems: 'end' }}>
        {clubs.length > 1 && (
          <label>Golf<select value={clubId ?? ''} onChange={(e) => { setClubId(e.target.value); setTarget(null); }}>
            {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        )}
        <label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <div className="row" style={{ gap: 4 }}>
          <button className="btn sm" onClick={() => setDate(addDays(date, -1))} aria-label="Jour précédent">◀</button>
          <button className={`btn sm ${date === today ? 'primary' : ''}`} onClick={() => setDate(today)}>Aujourd'hui</button>
          <button className="btn sm" onClick={() => setDate(addDays(date, 1))} aria-label="Jour suivant">▶</button>
        </div>
        <span className="spacer" />
        <div className="res-legend small" aria-label="Légende des statuts">
          {(Object.keys(STATUS) as ResourceStatus[]).map((s) => <ResourceStatusBadge key={s} status={s} />)}
        </div>
      </div>
      {date && <h2 style={{ textTransform: 'capitalize', margin: 0 }}>{club?.name} — {longDate(date)}{loading && <span className="small muted"> · actualisation…</span>}</h2>}
      <ErrorBox error={error} />
      {notice && <div className="alert ok" role="status">{notice}</div>}
      {!board && loading && <div className="card small muted" aria-live="polite">Chargement des disponibilités…</div>}

      {board && board.conflicts.length > 0 && (
        <div className="card stack" style={{ borderColor: 'var(--color-danger)', gap: 8 }} role="region" aria-label="Conflits à résoudre">
          <h3 style={{ margin: 0 }}>⚠ {board.conflicts.length} affectation(s) à revoir</h3>
          <p className="small muted" style={{ margin: 0 }}>Ces réservations utilisent un caddie ou un matériel déclaré indisponible. Choisissez un remplaçant libre.</p>
          {board.conflicts.map((c: any) => (
            <div key={`${c.unavailabilityId}-${c.allocationId ?? c.teeTimeId}`} className="res-line">
              <div className="stack" style={{ gap: 4, flex: 1 }}>
                <span><strong>{c.label}</strong> ({c.reason}) — {c.references.join(', ')} · {c.localDate === date ? '' : `${c.localDate} `}{c.localTime}</span>
                {c.kind === 'unit'
                  ? <ReassignUnit allocationId={c.allocationId} canAssign={perms.assign} onChanged={load} />
                  : <CaddieAssign teeTimeId={c.teeTimeId} reserved name={c.label} canAssign={perms.assign} onChanged={load} />}
              </div>
            </div>
          ))}
          {!perms.assign && <p className="caption muted" style={{ margin: 0 }}>La réaffectation est faite par le starter ou la direction.</p>}
        </div>
      )}

      {board && (
        <div className="res-cards">
          {board.types.map((t: any) => {
            const free = board.isToday ? t.availableNow : t.lowestAvailable;
            return (
              <div key={t.id} className="card res-card">
                <div className="small muted">{t.name}</div>
                <div className="res-big"><span className="num">{free}</span><span className="small muted"> / {t.capacity}</span></div>
                <div className="caption">{board.isToday ? 'libres maintenant' : 'libres au moment le plus chargé'}</div>
                <div className="caption muted">
                  {board.isToday && <>{t.inUseNow} en utilisation · </>}
                  {t.reservedPeak} réservé(s) au plus fort · {board.isToday ? t.unavailableNow : t.unavailablePeak} indisponible(s)
                </div>
              </div>
            );
          })}
          {board.types.length === 0 && <div className="card small muted">Aucune ressource configurée pour ce golf (Configuration › Matériel).</div>}
        </div>
      )}

      {board && (
        <div className="layout">
          <div className="card stack">
            <div className="segmented" role="tablist" aria-label="Vue">
              {([['equipment', 'Matériel'], ['caddies', 'Caddies'], ['unavailable', `Maintenances et absences (${board.unavailabilities.length})`]] as const).map(([k, l]) => (
                <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>
              ))}
            </div>

            {tab === 'equipment' && (byType.length === 0
              ? <p className="small muted" style={{ margin: 0 }}>Aucun matériel numéroté. Ajoutez les numéros dans Configuration › Matériel pour suivre chaque unité.</p>
              : byType.map(([type, units]) => {
                const counts = (Object.keys(STATUS) as ResourceStatus[]).map((st) => [st, units.filter((u: any) => u.status === st).length] as const).filter(([, n]) => n > 0);
                return (
                  <details key={type} open className="res-type">
                    <summary><strong>{type}</strong> <span className="small muted">— {counts.map(([st, n]) => `${n} ${STATUS[st].label.toLowerCase()}`).join(' · ')}</span></summary>
                    <ul className="unit-grid">
                      {units.map((u: any) => {
                        const detail = u.retired ? 'Retiré du service' : u.unavailability ? u.unavailability.text
                          : u.assignments.map((a: any) => `${a.from}–${a.to} ${a.reference}`).join(' · ');
                        const action = perms.manage && !u.retired
                          ? (u.unavailability ? () => end(u.unavailability.id, `${type} ${u.label}`) : () => setTarget({ unitId: u.id, label: `${type} ${u.label}`, kind: 'unit' }))
                          : null;
                        return (
                          <li key={u.id} className={`unit-tile ${u.status}`}>
                            <div className="row" style={{ gap: 6, alignItems: 'center', justifyContent: 'space-between' }}>
                              <strong className="num">{u.label}</strong>
                              <span className="caption">{STATUS[u.status as ResourceStatus].icon} {STATUS[u.status as ResourceStatus].label}</span>
                            </div>
                            {detail && <div className="caption muted unit-detail" title={detail}>{detail}</div>}
                            {action && <button className="btn sm ghost" onClick={action}>{u.unavailability ? 'Remettre en service' : 'Maintenance…'}</button>}
                          </li>
                        );
                      })}
                    </ul>
                  </details>
                );
              }))}

            {tab === 'caddies' && (board.caddies.length === 0
              ? <p className="small muted" style={{ margin: 0 }}>Aucun caddie enregistré (Configuration › Caddies).</p>
              : <div className="table-wrap"><table className="sheet res-table">
                  <thead><tr><th>Caddie</th><th>Statut</th><th>Départs du jour</th>{perms.manage && <th><span className="sr-only">Action</span></th>}</tr></thead>
                  <tbody>{board.caddies.map((c: any) => (
                    <tr key={c.id}>
                      <td><strong>{c.displayName}</strong></td>
                      <td><ResourceStatusBadge status={c.status} /></td>
                      <td className="small">
                        {c.unavailability && <div>{c.unavailability.text}</div>}
                        {c.assignments.length ? c.assignments.map((a: any) => <div key={a.teeTimeId}>{a.from}–{a.to}</div>) : !c.unavailability && <span className="muted">aucun</span>}
                      </td>
                      {perms.manage && <td>{c.unavailability
                        ? <button className="btn sm" onClick={() => end(c.unavailability.id, c.displayName)}>Déclarer disponible</button>
                        : <button className="btn sm" onClick={() => setTarget({ caddieId: c.id, label: c.displayName, kind: 'caddie' })}>Déclarer absent…</button>}</td>}
                    </tr>
                  ))}</tbody>
                </table></div>)}

            {tab === 'unavailable' && (board.unavailabilities.length === 0
              ? <p className="small muted" style={{ margin: 0 }}>Aucune maintenance ni absence en cours ou prévue.</p>
              : <ul className="plain-list">
                  {board.unavailabilities.map((u: any) => (
                    <li key={u.id} className="res-line">
                      <div className="stack" style={{ gap: 2, flex: 1 }}>
                        <span><strong>{u.label}</strong> {u.active ? <span className="badge danger">en cours</span> : <span className="badge info">prévue</span>}</span>
                        <span className="small">{u.text}</span>
                        <span className="caption muted">Depuis le {new Date(u.startsAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: club?.timezone })}{u.createdBy ? ` · déclarée par ${u.createdBy}` : ''}</span>
                      </div>
                      {perms.manage && <button className="btn sm" onClick={() => end(u.id, u.label)}>{u.active ? 'Remettre en service' : 'Annuler'}</button>}
                    </li>
                  ))}
                </ul>)}
            {!perms.manage && <p className="caption muted" style={{ margin: 0 }}>Les maintenances et absences sont déclarées par la direction.</p>}
          </div>
          <div className="panel">
            {target && club
              ? <DeclarePanel key={(target.unitId ?? target.caddieId)!} clubId={club.id} timezone={club.timezone} target={target}
                  canAssign={perms.assign} onClose={() => setTarget(null)} onDone={(msg) => { setNotice(msg); load(); }} />
              : <div className="card small muted">
                  Statuts : <strong>Disponible</strong> (libre), <strong>Réservé</strong> (affecté à un départ à venir), <strong>En utilisation</strong> (départ en cours),
                  {' '}<strong>Indisponible</strong> (maintenance, absence ou retiré). La disponibilité tient compte de toute la durée de jeu et du temps de préparation.
                </div>}
          </div>
        </div>
      )}
    </div>
  );
}

/** Remplacer le n° d'une affectation en conflit. */
function ReassignUnit({ allocationId, canAssign, onChanged }: { allocationId: string; canAssign: boolean; onChanged: () => void }) {
  const [info, setInfo] = useState<any>(null);
  useEffect(() => { get(`/api/allocations/${allocationId}/unit-options`).then(setInfo).catch(() => undefined); }, [allocationId]);
  if (!info) return null;
  const units = info.units.filter((u: any) => info.assigned.includes(u.id)).map((u: any) => ({ id: u.id, label: u.label }));
  return <UnitsAssign allocationId={allocationId} typeName={info.typeName} quantity={info.quantity} units={units} canAssign={canAssign} onChanged={onChanged} />;
}

function DeclarePanel({ clubId, timezone, target, canAssign, onClose, onDone }: {
  clubId: string; timezone: string; target: Target; canAssign: boolean; onClose: () => void; onDone: (msg: string) => void;
}) {
  const [from, setFrom] = useState(nowLocalInput(timezone));
  const [open, setOpen] = useState(true);
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  const isUnit = target.kind === 'unit';

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await post(`/api/clubs/${clubId}/unavailabilities`, {
        ...(isUnit ? { unitId: target.unitId } : { caddieId: target.caddieId }),
        startsAt: clubLocalToIso(from, timezone), endsAt: open || !to ? null : clubLocalToIso(to, timezone), reason: reason.trim(),
      });
      setResult(r);
      onDone(`${target.label} : ${isUnit ? 'maintenance enregistrée' : 'indisponibilité enregistrée'}.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <div className="card stack">
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ margin: 0 }}>{target.label}</h2>
          <button className="btn sm" onClick={onClose} aria-label="Fermer">✕</button>
        </div>
        <div className="alert ok" role="status">{isUnit ? 'Maintenance enregistrée.' : 'Indisponibilité enregistrée.'}</div>
        {result.affected.length > 0 ? (
          <>
            <div className="alert" role="alert">{result.affected.length} réservation(s) concernée(s) : choisissez un remplaçant.</div>
            {result.affected.map((c: any) => (
              <div key={c.allocationId ?? c.teeTimeId} className="stack" style={{ gap: 4 }}>
                <span className="small"><strong>{c.references.join(', ')}</strong> · {c.localDate} {c.localTime}</span>
                {c.kind === 'unit'
                  ? <ReassignUnit allocationId={c.allocationId} canAssign={canAssign} onChanged={() => onDone('Réaffectation enregistrée.')} />
                  : <CaddieAssign teeTimeId={c.teeTimeId} reserved name={c.label} canAssign={canAssign} onChanged={() => onDone('Réaffectation enregistrée.')} />}
              </div>
            ))}
          </>
        ) : <p className="small muted" style={{ margin: 0 }}>Aucune réservation n'utilisait {target.label} sur cette période.</p>}
        {result.overflow > 0 && (
          <div className="alert" role="alert">Attention : {result.overflow} {result.typeName.toLowerCase()} réservé(s) de plus que d'unités en service sur cette période. Prévenez l'accueil.</div>
        )}
        <button className="btn" onClick={onClose}>Terminé</button>
      </div>
    );
  }

  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>{isUnit ? 'Mettre en maintenance' : 'Déclarer absent'}</h2>
        <button className="btn sm" onClick={onClose} aria-label="Fermer">✕</button>
      </div>
      <p style={{ margin: 0 }}><strong>{target.label}</strong></p>
      <label>À partir du<input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} required /></label>
      <label className="check"><input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} /> Jusqu'à nouvel ordre</label>
      {!open && <label>Jusqu'au<input type="datetime-local" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>}
      <label>Motif *<input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={isUnit ? 'Ex. pneu crevé' : 'Ex. congé'} maxLength={300} /></label>
      <div className="row" style={{ gap: 4 }} aria-label="Motifs fréquents">
        {REASONS[target.kind].map((r) => <button key={r} type="button" className="btn sm ghost" onClick={() => setReason(r)}>{r}</button>)}
      </div>
      <p className="caption muted" style={{ margin: 0 }}>Les réservations déjà affectées sur cette période seront listées pour réaffectation.</p>
      <ErrorBox error={error} />
      <div className="row">
        <button className="btn primary" disabled={busy || !reason.trim() || !from || (!open && !to)} onClick={save}>{busy ? 'Enregistrement…' : 'Enregistrer'}</button>
        <button className="btn" onClick={onClose}>Annuler</button>
      </div>
    </div>
  );
}
