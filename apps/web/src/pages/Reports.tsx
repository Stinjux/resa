// Rapports modulables : blocs d'indicateurs au choix (ordre mémorisé sur le
// compte), filtres libres, comparaison, export Excel / PDF, envois programmés,
// et analyse rédigée par l'IA (un golf à la fois).

import { useEffect, useMemo, useState } from 'react';
import { download, get, patch, post, put, api, type User } from '../api';
import { addDays, money, todayIn } from '../format';
import { useI18n } from '../i18n';
import { ErrorBox, useClubs } from './common';
import { Markdown } from './Markdown';

type BlockId = 'kpis' | 'occupancy' | 'amounts' | 'cancellations' | 'channels' | 'equipment' | 'caddieStaff'
  | 'revenue' | 'clubs' | 'categories' | 'partners' | 'weekdays' | 'hours' | 'daily' | 'payments' | 'customers';
const BLOCKS: Array<[BlockId, string]> = [
  ['kpis', 'Chiffres clés'], ['occupancy', 'Occupation et départs exclusifs'], ['amounts', 'Montants'], ['cancellations', 'Annulations et absences'],
  ['channels', 'Par canal'], ['equipment', 'Voiturettes, chariots et sacs'], ['caddieStaff', 'Caddies'],
  ['revenue', "Chiffre d'affaires par poste"], ['clubs', 'Par golf'], ['categories', 'Par catégorie de client'], ['partners', 'Tour-opérateurs et partenaires'],
  ['weekdays', 'Par jour de la semaine'], ['hours', 'Par heure de départ'], ['daily', 'Jour par jour'], ['payments', 'Encaissements par mode'], ['customers', 'Clientèle'],
];
const LABEL = Object.fromEntries(BLOCKS) as Record<BlockId, string>;
const DEFAULT_BLOCKS: BlockId[] = ['kpis', 'occupancy', 'amounts', 'cancellations', 'channels', 'equipment', 'caddieStaff'];
/** Anciens blocs enregistrés dans les préférences. */
const LEGACY: Record<string, BlockId[]> = { caddies: ['equipment', 'caddieStaff'] };
const NA = 'Données non disponibles';
const CHANNELS: Record<string, string> = { web: 'Web', phone: 'Téléphone', group: 'Groupe', walk_in: 'Sur place', staff: 'Personnel', whatsapp: 'WhatsApp', sms: 'SMS', partner: 'Portail partenaire' };
const KINDS: Record<string, string> = { green_fee: 'Green fees', caddie: 'Caddies', resource: 'Matériel', private_surcharge: 'Suppléments privés', cancellation_fee: "Frais d'annulation", no_show_fee: "Frais d'absence" };
const METHODS: Record<string, string> = { cash: 'Espèces', card_terminal: 'Carte (TPE)', bank_transfer: 'Virement', online: 'En ligne', pos: 'Caisse', other: 'Autre' };
const WEEKDAYS = ['', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
const PERIODS: Array<[string, string]> = [['previous_week', 'Semaine précédente'], ['previous_month', 'Mois précédent'], ['last_7_days', '7 derniers jours'],
  ['last_30_days', '30 derniers jours'], ['month_to_date', 'Mois en cours']];
const pct = (x: number | null | undefined) => (x === null || x === undefined ? NA : `${(Math.round(x * 1000) / 10).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %`);
const num = (x: number | null | undefined) => (x === null || x === undefined ? NA : x.toLocaleString('fr-FR', { maximumFractionDigits: 1 }));

// ------------------------------------------------------------------ Blocs

/** Barre de magnitude (une seule teinte) ; la valeur reste écrite à côté. */
function Bar({ value, max }: { value: number; max: number }) {
  return <span className="dbar" aria-hidden><span style={{ width: `${max ? Math.max(2, (value / max) * 100) : 0}%` }} /></span>;
}

function Delta({ now, before, invert = false }: { now: number; before: number | undefined; invert?: boolean }) {
  if (before === undefined) return null;
  if (!before) return <span className="delta">—</span>;
  const d = (now - before) / before;
  const up = d > 0.0005;
  const down = d < -0.0005;
  const good = invert ? down : up;
  const cls = up || down ? (good ? 'delta good' : 'delta bad') : 'delta';
  return <span className={cls}><span aria-hidden>{up ? '▲' : down ? '▼' : '='}</span> {up ? '+' : ''}{pct(d)}</span>;
}

function Kpis({ d, cur }: { d: any; cur: string | null }) {
  const c = d.current;
  const p = d.previous ?? undefined;
  const m = (x: number | null) => (x === null || !cur ? NA : money(x, cur));
  const tiles: Array<[string, string, number | null, number | null | undefined, boolean?]> = [
    ['Réservations', num(c.bookings), c.bookings, p?.bookings],
    ['Joueurs', num(c.players), c.players, p?.players],
    ["Taux d'occupation", pct(c.occupancyRate), c.occupancyRate, p?.occupancyRate],
    ['Départs exclusifs', num(c.exclusiveTeeTimes), c.exclusiveTeeTimes, p?.exclusiveTeeTimes],
    ['Montant réservé', m(c.revenueMinor), c.revenueMinor, p?.revenueMinor],
    ['Encaissé (net)', m(c.collectedMinor), c.collectedMinor, p?.collectedMinor],
    ['Solde à recevoir', m(c.receivableMinor), c.receivableMinor, p?.receivableMinor, true],
    ['Annulations', num(c.cancellations), c.cancellations, p?.cancellations, true],
  ];
  return (
    <>
      <div className="kpis">
        {tiles.map(([label, value, now, before, invert]) => (
          <div key={label} className="kpi">
            <div className="kpi-label">{label}</div>
            <div className={`kpi-value ${value === NA ? 'na' : ''}`}>{value}</div>
            {now !== null && before !== null && <Delta now={now} before={before} invert={invert} />}
          </div>
        ))}
      </div>
      <p className="caption muted" style={{ margin: '8px 0 0' }}>
        {c.players} joueur(s) pour {num(c.capacity)} places ouvertes à la vente.{p && ` Comparaison avec le ${p.from} → ${p.to}.`}
      </p>
    </>
  );
}

function Rows({ rows }: { rows: Array<[string, string | number, boolean?]> }) {
  return (
    <table className="lines figures"><tbody>
      {rows.map(([label, value, total], i) => (
        <tr key={i} className={total ? 'total' : ''}><td>{label}</td><td className={value === NA ? 'na' : ''}>{value}</td></tr>
      ))}
    </tbody></table>
  );
}

function BarTable({ head, rows, valueIndex = 1 }: { head: string[]; rows: Array<Array<string | number>>; valueIndex?: number }) {
  const max = Math.max(0, ...rows.map((r) => Number(r[valueIndex]) || 0));
  return (
    <table className="lines figures dtable">
      <thead><tr>{head.map((h, i) => <th key={i}>{h}</th>)}</tr></thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => <td key={j}>{j === valueIndex ? <span className="dval"><Bar value={Number(c) || 0} max={max} /><span>{num(Number(c) || 0)}</span></span> : c}</td>)}
          </tr>
        ))}
        {rows.length === 0 && <tr><td colSpan={head.length} className="muted">Aucune donnée sur la période.</td></tr>}
      </tbody>
    </table>
  );
}

function Block({ id, d, cur, multiClub }: { id: BlockId; d: any; cur: string | null; multiClub: boolean }) {
  const m = (x: number | null | undefined, c: string | null = cur) => (x === null || x === undefined || !c ? NA : money(x, c));
  switch (id) {
    case 'kpis': return <Kpis d={d} cur={cur} />;
    case 'occupancy': return (
      <>
        <div className="kpis mini">
          <div className="kpi"><div className="kpi-label">Taux d'occupation</div><div className="kpi-value">{pct(d.occupancyRate)}</div>
            <div className="caption muted">{d.players} joueurs / {d.openSeats} places</div></div>
          <div className="kpi"><div className="kpi-label">Départs exclusifs</div><div className="kpi-value">{d.exclusiveTeeTimes}</div>
            <div className="caption muted">{d.exclusivePlayers} joueurs, {d.exclusiveNeutralizedSeats} places neutralisées</div></div>
        </div>
        <Rows rows={[
          ['Places de la grille', num(d.gridSeats)], ['Places fermées (départs bloqués)', `${d.closedSeats} (${d.closedTeeTimes} départ(s))`],
          ['Places ouvertes à la vente', num(d.openSeats), true], ['Départs occupés', num(d.teeTimes)], ['Joueurs par départ', num(d.avgPlayersPerTeeTime)],
          ['Places vendues (joueurs + exclusivité)', pct(d.soldRate)],
        ]} />
      </>
    );
    case 'amounts': {
      if (d.length === 0) return <p className="small muted" style={{ margin: 0 }}>Aucune réservation sur la période.</p>;
      // Une colonne par devise : jamais d'addition entre devises.
      const lines: Array<[string, string, boolean?]> = [['Réservé', 'bookedMinor'], ["Frais d'annulation", 'cancellationFeesMinor'],
        ['Encaissé', 'paidMinor'], ['Remboursé', 'refundedMinor'], ['Net encaissé', 'netMinor', true], ['Solde à recevoir', 'receivableMinor', true],
        ['À rembourser', 'refundDueMinor']];
      return (
        <table className="lines figures">
          {d.length > 1 && <thead><tr><th /> {d.map((a: any) => <th key={a.currency}>{a.currency}</th>)}</tr></thead>}
          <tbody>{lines.map(([label, key, strong]) => (
            <tr key={key} className={strong ? 'total' : ''}><td>{label}</td>{d.map((a: any) => <td key={a.currency}>{m(a[key], a.currency)}</td>)}</tr>
          ))}</tbody>
        </table>
      );
    }
    case 'cancellations': return <Rows rows={[
      ['Annulations', `${d.cancellations} (${d.cancelledPlayers} joueurs)`], ["Taux d'annulation", pct(d.cancellationRate)],
      ['Absences', d.noShows === null ? NA : `${d.noShows} (${d.noShowPlayers} joueurs)`], ["Taux d'absence (départs passés)", pct(d.noShowRate)],
    ]} />;
    case 'equipment': return (
      <table className="lines figures dtable">
        <thead><tr><th>Matériel</th><th>Unités réservées</th><th>Pic / parc</th><th>Jours au complet</th><th>N° affectés</th></tr></thead>
        <tbody>
          {d.map((e: any) => (
            <tr key={e.name}><td>{e.name.replace(/^Sac de location /, 'Sac ')}</td>
              <td><span className="dval"><Bar value={e.peak} max={e.capacity} /><span>{e.quantity}</span></span></td>
              <td>{e.peak} / {e.capacity}</td><td>{e.daysAtCapacity}</td><td>{e.quantity ? `${e.assignedUnits} (${pct(e.assignedRate)})` : '—'}</td></tr>
          ))}
          {d.length === 0 && <tr><td colSpan={5} className="muted">Aucun matériel réservé sur la période.</td></tr>}
        </tbody>
      </table>
    );
    case 'caddieStaff': return (
      <>
        <Rows rows={[['Départs avec caddie réservé', num(d.withCaddie)], ['dont caddie nommé', num(d.named)]]} />
        {d.perCaddie && <BarTable head={['Caddie', 'Départs', 'Jours travaillés']}
          rows={d.perCaddie.map((x: any) => [multiClub ? `${x.name} (${x.club})` : x.name, x.teeTimes, x.days])} />}
      </>
    );
    case 'revenue': return (
      <table className="lines figures"><tbody>
        {Object.entries(d.byKind).map(([k, v]) => <tr key={k}><td>{KINDS[k] ?? k}</td><td>{m(v as number)}</td></tr>)}
        <tr className="total"><td>Total</td><td>{m(d.totalMinor)}</td></tr>
        <tr><td className="muted">payé par les clients</td><td className="muted">{m(d.byPayer.customer ?? 0)}</td></tr>
        <tr><td className="muted">payé par les partenaires</td><td className="muted">{m(d.byPayer.partner ?? 0)}</td></tr>
        <tr><td className="muted">frais d'annulation (réservations annulées)</td><td className="muted">{m(d.cancellationFeesMinor)}</td></tr>
      </tbody></table>
    );
    case 'clubs': return <BarTable head={['Golf', 'Joueurs', 'Occupation', 'Montant réservé']}
      rows={d.map((c: any) => [c.name, c.players, pct(c.occupancyRate), m(c.revenueMinor, c.currency)])} />;
    case 'channels': return <BarTable head={['Canal', 'Joueurs', 'Réservations', 'Montant réservé']}
      rows={d.map((g: any) => [CHANNELS[g.key] ?? g.key, g.players, g.bookings, m(g.revenueMinor)])} />;
    case 'categories': return <BarTable head={['Catégorie', 'Joueurs', 'Réservations', 'Montant réservé']}
      rows={d.map((g: any) => [g.key, g.players, g.bookings, m(g.revenueMinor)])} />;
    case 'partners': return <BarTable head={['Partenaire', 'Joueurs', 'Part partenaire', 'Total']}
      rows={d.map((p: any) => [p.name, p.players, m(p.partnerMinor), m(p.revenueMinor)])} />;
    case 'weekdays': return <BarTable head={['Jour', 'Joueurs', 'Occupation']}
      rows={d.map((w: any) => [WEEKDAYS[w.weekday]!, w.players, pct(w.occupancyRate)])} />;
    case 'hours': return <BarTable head={['Heure', 'Joueurs']} rows={d.map((h: any) => [`${String(h.hour).padStart(2, '0')} h`, h.players])} />;
    case 'daily': return <BarTable head={['Date', 'Joueurs', 'Occupation', 'Montant réservé']}
      rows={d.map((x: any) => [x.date, x.players, pct(x.occupancyRate), m(x.revenueMinor)])} />;
    case 'payments': return (
      <table className="lines figures"><tbody>
        {d.byMethod.map((p: any) => <tr key={p.method}><td>{METHODS[p.method] ?? p.method}</td><td>{m(p.paidMinor)}{p.refundedMinor > 0 && <span className="muted"> (− {m(p.refundedMinor)})</span>}</td></tr>)}
        {d.byMethod.length === 0 && <tr><td className="muted" colSpan={2}>Aucun encaissement.</td></tr>}
        <tr className="total"><td>Solde à recevoir</td><td>{m(d.outstandingMinor)}</td></tr>
        <tr><td className="muted">À rembourser</td><td className="muted">{m(d.refundDueMinor)}</td></tr>
      </tbody></table>
    );
    case 'customers': return (
      <table className="lines figures"><tbody>
        <tr><td>Clients distincts</td><td>{d.distinct}</td></tr>
        <tr><td>dont nouveaux</td><td>{d.firstTime}</td></tr>
        <tr><td>dont membres</td><td>{d.members}</td></tr>
      </tbody></table>
    );
  }
}

// ------------------------------------------------------------------ Page

export function Reports({ user }: { user: User }) {
  const clubs = useClubs(user, ['org_admin', 'club_admin']);
  const [clubIds, setClubIds] = useState<string[]>([]);
  const firstClub = clubs.find((c) => c.id === clubIds[0]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [compare, setCompare] = useState<'none' | 'previous' | 'last_year'>('previous');
  const [channels, setChannels] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [allCategories, setAllCategories] = useState<string[]>([]);
  const [partnerId, setPartnerId] = useState('');
  const [partners, setPartners] = useState<any[]>([]);
  const [blocks, setBlocks] = useState<BlockId[]>(DEFAULT_BLOCKS);
  const [editBlocks, setEditBlocks] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [report, setReport] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Par défaut : tous les golfs accessibles (vue groupe) ; on affine en décochant.
  useEffect(() => { if (!clubIds.length && clubs.length) setClubIds(clubs.map((c) => c.id)); }, [clubs]);
  useEffect(() => {
    get<{ preferences: { reportBlocks?: string[] } }>('/api/me/preferences')
      .then((r) => {
        const b = [...new Set((r.preferences.reportBlocks ?? []).flatMap((x) => LEGACY[x] ?? [x]).filter((x) => x in LABEL))] as BlockId[];
        if (b.length) setBlocks(b);
      }).catch(() => undefined);
    get('/api/partners').then((r) => setPartners(r.partners)).catch(() => undefined);
  }, []);
  const [period, setPeriod] = useState<'today' | 'week' | 'month' | 'custom'>('week');
  useEffect(() => { if (firstClub && !from) preset('week'); }, [firstClub?.id]);
  useEffect(() => {
    Promise.all(clubIds.map((id) => get<{ categories: string[] }>(`/api/clubs/${id}/customer-categories`).then((r) => r.categories).catch(() => [])))
      .then((lists) => setAllCategories([...new Set(['standard', ...lists.flat()])]));
  }, [clubIds.join()]);

  const config = useMemo(() => ({
    clubIds, from, to, compare, blocks,
    channels: channels.length ? channels : null, categories: categories.length ? categories : null, partnerId: partnerId || null,
  }), [clubIds, from, to, compare, blocks, channels, categories, partnerId]);

  useEffect(() => {
    if (!clubIds.length || !from || !to) return;
    setLoading(true);
    setError(null);
    post('/api/analytics', config).then((r) => setReport(r.report)).catch((e) => { setReport(null); setError(e.message); }).finally(() => setLoading(false));
  }, [config]);

  /** Périodes usuelles, en date du golf : semaine du lundi au dimanche, mois civil complet. */
  function preset(kind: 'today' | 'week' | 'month' | 'custom') {
    setPeriod(kind);
    if (!firstClub || kind === 'custom') return;
    const today = todayIn(firstClub.timezone);
    const [y, mo] = today.split('-').map(Number) as [number, number];
    if (kind === 'today') { setFrom(today); setTo(today); }
    if (kind === 'week') {
      const wd = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7; // 0 = lundi
      setFrom(addDays(today, -wd)); setTo(addDays(today, 6 - wd));
    }
    if (kind === 'month') { setFrom(`${today.slice(0, 7)}-01`); setTo(new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10)); }
  }
  const toggle = (list: string[], v: string, set: (l: string[]) => void) => set(list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const filterCount = channels.length + categories.length + (partnerId ? 1 : 0);

  return (
    <div className="stack reports">
      <div className="card stack no-print" style={{ gap: 10 }}>
        <div className="row" style={{ alignItems: 'end' }}>
          {clubs.length > 1 && (
            <fieldset className="chipset">
              <legend>Golfs</legend>
              <label className={`chip-toggle ${clubIds.length === clubs.length ? 'on' : ''}`}>
                <input type="checkbox" checked={clubIds.length === clubs.length} onChange={() => setClubIds(clubs.map((c) => c.id))} />
                {clubIds.length === clubs.length && <span aria-hidden>✓ </span>}Tous
              </label>
              {clubs.map((c) => (
                <label key={c.id} className={`chip-toggle ${clubIds.includes(c.id) ? 'on' : ''}`}>
                  <input type="checkbox" checked={clubIds.includes(c.id)} onChange={() => toggle(clubIds, c.id, (l) => l.length && setClubIds(l))} />
                  {clubIds.includes(c.id) && <span aria-hidden>✓ </span>}{c.name}
                </label>
              ))}
            </fieldset>
          )}
          <div className="stack" style={{ gap: 4 }}>
            <span className="small" style={{ fontWeight: 600 }}>Période</span>
            <div className="segmented" role="radiogroup" aria-label="Période">
              {([['today', "Aujourd'hui"], ['week', 'Cette semaine'], ['month', 'Ce mois'], ['custom', 'Personnalisée']] as const).map(([k, l]) => (
                <button key={k} role="radio" aria-checked={period === k} className={period === k ? 'active' : ''} onClick={() => preset(k)}>{l}</button>
              ))}
            </div>
          </div>
          {period === 'custom' && <>
            <label>Du<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label>Au<input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
          </>}
          <label>Comparer avec<select value={compare} onChange={(e) => setCompare(e.target.value as typeof compare)}>
            <option value="previous">Période précédente</option><option value="last_year">Même période l'an dernier</option><option value="none">Sans comparaison</option>
          </select></label>
        </div>
        <div className="row" style={{ alignItems: 'center' }}>
          <span className="small muted">{clubIds.length === clubs.length && clubs.length > 1 ? 'Vue globale : tous vos golfs' : `${clubIds.length} golf(s)`} · du {from} au {to}</span>
          <span className="spacer" />
          <button className="btn sm" aria-expanded={showFilters} onClick={() => setShowFilters(!showFilters)}>Filtres{filterCount ? ` (${filterCount})` : ''} ▾</button>
          <button className="btn sm" onClick={() => setEditBlocks(true)}>⚙ Indicateurs</button>
          <button className="btn sm" disabled={!report} onClick={() => download(`/api/analytics.csv?config=${encodeURIComponent(JSON.stringify(config))}`, `rapport-${from}_${to}.csv`)
            .catch((e) => setError(e.message))}>⬇ Excel</button>
          <button className="btn sm" disabled={!report} onClick={() => window.print()}>🖨 PDF</button>
        </div>
        {showFilters && (
          <div className="stack" style={{ gap: 8 }}>
            <fieldset className="chipset"><legend>Canaux</legend>
              {Object.entries(CHANNELS).map(([k, l]) => (
                <label key={k} className={`chip-toggle ${channels.includes(k) ? 'on' : ''}`}>
                  <input type="checkbox" checked={channels.includes(k)} onChange={() => toggle(channels, k, setChannels)} />{channels.includes(k) && <span aria-hidden>✓ </span>}{l}
                </label>
              ))}
            </fieldset>
            <fieldset className="chipset"><legend>Catégories de client</legend>
              {allCategories.map((k) => (
                <label key={k} className={`chip-toggle ${categories.includes(k) ? 'on' : ''}`}>
                  <input type="checkbox" checked={categories.includes(k)} onChange={() => toggle(categories, k, setCategories)} />{categories.includes(k) && <span aria-hidden>✓ </span>}{k}
                </label>
              ))}
            </fieldset>
            <div className="row">
              <label>Partenaire<select value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
                <option value="">Tous (y compris clients directs)</option>
                {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
              {filterCount > 0 && <button className="btn sm ghost" onClick={() => { setChannels([]); setCategories([]); setPartnerId(''); }}>Effacer les filtres</button>}
            </div>
          </div>
        )}
      </div>

      <ErrorBox error={error} />
      {report && (
        <>
          <div className="print-only"><h1>Rapport · {report.clubs.map((c: any) => c.name).join(', ')}</h1><p>Du {report.period.from} au {report.period.to}</p></div>
          <p className="small muted no-print" style={{ margin: 0 }}>{report.clubs.map((c: any) => c.name).join(', ')} · du {report.period.from} au {report.period.to}
            {loading && ' · actualisation…'} · départs de la période, chiffres calculés par Resa à partir des réservations enregistrées.</p>
          <div className="dash">
            {report.blocks.map((b: BlockId) => (
              <section key={b} className={`card stack dash-${b}`} style={{ gap: 8 }}>
                <h2 style={{ margin: 0 }}>{LABEL[b]}</h2>
                {report.unavailable[b]
                  ? <div className="na-box"><strong>{NA}</strong><span className="small">{report.unavailable[b]}</span></div>
                  : <Block id={b} d={report.data[b]} cur={report.currency} multiClub={report.clubs.length > 1} />}
                {(report.notes[b] ?? []).map((n: string) => <p key={n} className="small na-note" style={{ margin: 0 }}>{n}</p>)}
                {report.definitions[b] && (
                  <details className="no-print"><summary className="caption">Comment c'est calculé</summary>
                    <p className="caption muted" style={{ margin: '4px 0 0' }}>{report.definitions[b]}</p></details>
                )}
              </section>
            ))}
          </div>
        </>
      )}
      <div className="no-print"><Schedules config={config} /></div>
      {clubIds.length === 1 && firstClub && <div className="no-print"><AiAnalysis clubId={clubIds[0]!} from={from} to={to} /></div>}

      {editBlocks && <BlocksEditor blocks={blocks} onClose={() => setEditBlocks(false)}
        onSave={(b) => { setBlocks(b); setEditBlocks(false); put('/api/me/preferences', { reportBlocks: b }).catch(() => undefined); }} />}
    </div>
  );
}

function BlocksEditor({ blocks, onSave, onClose }: { blocks: BlockId[]; onSave: (b: BlockId[]) => void; onClose: () => void }) {
  const [order, setOrder] = useState<BlockId[]>([...blocks, ...BLOCKS.map(([id]) => id).filter((id) => !blocks.includes(id))]);
  const [on, setOn] = useState<Set<BlockId>>(new Set(blocks));
  const move = (i: number, d: -1 | 1) => { const n = [...order]; [n[i], n[i + d]] = [n[i + d]!, n[i]!]; setOrder(n); };
  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal stack" role="dialog" aria-modal="true" aria-labelledby="blocks-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="blocks-title">Indicateurs du rapport</h2>
        <p className="small muted" style={{ margin: 0 }}>Cochez les blocs à afficher et réglez leur ordre. Votre choix est enregistré sur votre compte.</p>
        <ul className="orderable">
          {order.map((id, i) => (
            <li key={id}>
              <label className="check" style={{ flex: 1 }}><input type="checkbox" checked={on.has(id)} onChange={(e) => {
                const n = new Set(on); if (e.target.checked) n.add(id); else n.delete(id); setOn(n);
              }} /> {LABEL[id]}</label>
              <button className="btn sm icon" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Monter ${LABEL[id]}`}>↑</button>
              <button className="btn sm icon" disabled={i === order.length - 1} onClick={() => move(i, 1)} aria-label={`Descendre ${LABEL[id]}`}>↓</button>
            </li>
          ))}
        </ul>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <button className="btn ghost" onClick={() => { setOrder([...DEFAULT_BLOCKS, ...BLOCKS.map(([id]) => id).filter((id) => !DEFAULT_BLOCKS.includes(id))]); setOn(new Set(DEFAULT_BLOCKS)); }}>Par défaut</button>
          <div className="row">
            <button className="btn" onClick={onClose}>Annuler</button>
            <button className="btn primary" disabled={on.size === 0} onClick={() => onSave(order.filter((id) => on.has(id)))}>Appliquer</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Envois programmés

function Schedules({ config }: { config: any }) {
  const [list, setList] = useState<any[]>([]);
  const [form, setForm] = useState<any>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => get('/api/report-schedules').then((r) => setList(r.schedules)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const act = (fn: () => Promise<unknown>, ok?: string) => { setError(null); fn().then(() => { if (ok) setMessage(ok); load(); }).catch((e) => setError(e.message)); };

  return (
    <div className="card stack">
      <div className="row" style={{ alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>Envois automatiques par e-mail</h2>
        <span className="spacer" />
        <button className="btn sm" onClick={() => { setForm({ name: 'Bilan hebdomadaire', frequency: 'weekly', period: 'previous_week', recipients: '' }); setMessage(null); }}>+ Programmer ce rapport</button>
      </div>
      <p className="small muted" style={{ margin: 0 }}>Le rapport affiché (golfs, filtres, indicateurs) est envoyé chaque lundi ou chaque 1er du mois à 7 h, avec le détail en Excel.</p>
      {form && (
        <div className="stack" style={{ gap: 8 }}>
          <div className="grid2">
            <label>Nom<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label>Fréquence<select value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value, period: e.target.value === 'weekly' ? 'previous_week' : 'previous_month' })}>
              <option value="weekly">Chaque lundi</option><option value="monthly">Chaque 1er du mois</option></select></label>
            <label>Période couverte<select value={form.period} onChange={(e) => setForm({ ...form, period: e.target.value })}>
              {PERIODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
            <label>Destinataires (séparés par des virgules)<input value={form.recipients} placeholder="direction@golf.ma, compta@golf.ma"
              onChange={(e) => setForm({ ...form, recipients: e.target.value })} /></label>
          </div>
          <div className="row">
            <button className="btn primary" disabled={!form.name.trim() || !form.recipients.trim()} onClick={() => act(async () => {
              const { from: _f, to: _t, ...rest } = config;
              await post('/api/report-schedules', { name: form.name, frequency: form.frequency,
                recipients: form.recipients.split(/[,;\s]+/).filter(Boolean), config: { ...rest, period: form.period } });
              setForm(null);
            }, 'Envoi programmé.')}>Enregistrer</button>
            <button className="btn" onClick={() => setForm(null)}>Annuler</button>
          </div>
        </div>
      )}
      {message && <div className="alert ok">{message}</div>}
      <ErrorBox error={error} />
      {list.length > 0 && (
        <div className="table-wrap"><table className="sheet">
          <thead><tr><th>Envoi</th><th>Destinataires</th><th>Prochain</th><th>Dernier</th><th /></tr></thead>
          <tbody>{list.map((s) => (
            <tr key={s.id}>
              <td><strong>{s.name}</strong><div className="small muted">{s.frequency === 'weekly' ? 'chaque lundi' : 'chaque mois'} · {PERIODS.find(([k]) => k === s.config.period)?.[1]}</div></td>
              <td className="small">{s.recipients.join(', ')}</td>
              <td className="small">{s.active ? new Date(s.nextRunAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : <span className="badge">⏸ en pause</span>}</td>
              <td className="small">{s.lastRunAt ? <>{new Date(s.lastRunAt).toLocaleDateString('fr-FR')}{' '}
                {s.lastStatus === 'failed' ? <span className="badge danger" title={s.lastError ?? ''}>✕ échec</span>
                  : s.lastStatus === 'logged' ? <span className="badge">● journalisé</span> : <span className="badge success">✓ envoyé</span>}</> : '—'}</td>
              <td className="row" style={{ gap: 4 }}>
                <button className="btn sm" onClick={() => { setError(null); post(`/api/report-schedules/${s.id}/send`).then((r) => {
                  setMessage(r.status === 'sent' ? 'Rapport envoyé.' : "Rapport préparé mais non envoyé : aucun serveur d'e-mails configuré (SMTP_URL).");
                  load(); }).catch((e) => setError(e.message)); }}>Envoyer maintenant</button>
                <button className="btn sm" onClick={() => act(() => patch(`/api/report-schedules/${s.id}`, { active: !s.active }))}>{s.active ? 'Pause' : 'Reprendre'}</button>
                <button className="btn sm danger" onClick={() => window.confirm(`Supprimer « ${s.name} » ?`) && act(() => api('DELETE', `/api/report-schedules/${s.id}`))}>Supprimer</button>
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Analyse IA (un golf)

function AiAnalysis({ clubId, from, to }: { clubId: string; from: string; to: string }) {
  const { locale } = useI18n();
  const [focus, setFocus] = useState('');
  const [report, setReport] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [aiReady, setAiReady] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { get('/api/ai/status').then((s) => setAiReady(s.configured)).catch(() => setAiReady(false)); }, []);
  useEffect(() => { get(`/api/clubs/${clubId}/reports`).then((r) => setHistory(r.reports)).catch(() => undefined); setReport(null); }, [clubId]);

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ report: any }>(`/api/clubs/${clubId}/reports`, { from, to, focus: focus || null, locale });
      setReport(r.report);
      setHistory((h) => [{ ...r.report, from, to, focus }, ...h]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Analyse rédigée par l'IA</h2>
      {aiReady === false
        ? <p className="small muted" style={{ margin: 0 }}>IA non activée : ajoutez ANTHROPIC_API_KEY dans le fichier .env du serveur. Les indicateurs ci-dessus restent disponibles.</p>
        : <>
            <label>Point à approfondir (facultatif)<input value={focus} onChange={(e) => setFocus(e.target.value)} placeholder="Ex. le remplissage de l'après-midi, les impayés, les caddies…" /></label>
            <div className="row" style={{ alignItems: 'center' }}>
              <button className="btn" disabled={busy || !from || !to} onClick={generate}>{busy ? 'Rédaction en cours…' : "Rédiger l'analyse"}</button>
              <span className="small muted">L'IA reçoit uniquement des chiffres (aucune donnée personnelle). Période limitée à 92 jours.</span>
            </div>
          </>}
      <ErrorBox error={error} />
      {report && (
        <div>
          <div className="small muted">Période du {report.from ?? from} au {report.to ?? to} · {new Date(report.createdAt).toLocaleString()} · {report.model}</div>
          <Markdown text={report.content} />
        </div>
      )}
      {history.length > 0 && (
        <details>
          <summary className="small">Analyses précédentes ({history.length})</summary>
          <div className="stack" style={{ gap: 4, marginTop: 6 }}>
            {history.map((h) => (
              <button key={h.id} className="btn sm ghost" style={{ justifyContent: 'flex-start' }} onClick={() => get(`/api/reports/${h.id}`).then((r) => setReport(r.report))}>
                {h.from} → {h.to}{h.focus ? ` · ${h.focus}` : ''} · {new Date(h.createdAt).toLocaleDateString()}
              </button>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
