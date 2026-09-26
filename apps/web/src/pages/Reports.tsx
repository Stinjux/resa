import { useEffect, useState } from 'react';
import { get, post, type User } from '../api';
import { addDays, money, todayIn } from '../format';
import { useI18n } from '../i18n';
import { ErrorBox, useClubs } from './common';
import { Markdown } from './Markdown';

const WEEKDAYS = ['', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
const CHANNELS: Record<string, string> = { web: 'Web', phone: 'Téléphone', group: 'Groupe', walk_in: 'Sur place', staff: 'Personnel' };
const KINDS: Record<string, string> = { green_fee: 'Green fees', caddie: 'Caddies', resource: 'Matériel', private_surcharge: 'Suppléments privés' };
const METHODS: Record<string, string> = { cash: 'Espèces', card_terminal: 'Carte (TPE)', bank_transfer: 'Virement', online: 'En ligne', pos: 'Caisse', other: 'Autre' };
const pct = (x: number) => `${(Math.round(x * 1000) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 })} %`;
const dec = (x: number) => x.toLocaleString(undefined, { maximumFractionDigits: 1 });

function Figures({ d }: { d: any }) {
  const cur = d.club.currency;
  const rows: Array<[string, string]> = [
    ['Départs utilisés', String(d.activity.teeTimesUsed)],
    ['Réservations', String(d.activity.bookings)],
    ['Joueurs', String(d.activity.players)],
    ['Taux de remplissage', `${pct(d.activity.occupancyRate)} (${d.activity.players} / ${d.activity.capacityPlayers} places)`],
    ['Joueurs par départ', dec(d.activity.avgPlayersPerTeeTime)],
    ['Départs privés', String(d.activity.privateTeeTimes)],
    ['Annulations', String(d.activity.cancellations)],
    ['Chiffre d\'affaires (réservations)', money(d.revenue.totalMinor, cur)],
    ...Object.entries(d.revenue.byKind).map(([k, v]) => [`  dont ${KINDS[k] ?? k}`, money(v as number, cur)] as [string, string]),
    ['Frais d\'annulation', money(d.revenue.cancellationFeesMinor, cur)],
    ['Encaissé', money(d.revenue.collectedMinor, cur)],
    ...Object.entries(d.revenue.byMethod).map(([k, v]) => [`  dont ${METHODS[k] ?? k}`, money(v as number, cur)] as [string, string]),
    ['Reste à encaisser', money(d.revenue.outstandingMinor, cur)],
    ['À rembourser', money(d.revenue.refundDueMinor, cur)],
    ['Départs avec caddie (nommé)', `${d.caddies.teeTimesWithCaddie} (${d.caddies.named})`],
    ...d.equipment.map((e: any) => [e.name, `${e.units} location(s)`] as [string, string]),
    ['Clients distincts (dont nouveaux)', `${d.customers.distinct} (${d.customers.firstTimeInPeriod})`],
    ...Object.entries(d.activity.byChannel).map(([k, v]) => [`Réservations ${CHANNELS[k] ?? k}`, String(v)] as [string, string]),
  ];
  const busiest = [...d.activity.byWeekday].filter((w) => w.capacity > 0).sort((a, b) => b.players / b.capacity - a.players / a.capacity)[0];
  const peakHour = [...d.activity.byHour].sort((a, b) => b.players - a.players)[0];
  return (
    <div className="card stack">
      <h2 style={{ margin: 0 }}>Chiffres de la période</h2>
      <table className="lines figures"><tbody>
        {rows.map(([k, v], i) => <tr key={i}><td style={k.startsWith('  ') ? { paddingInlineStart: 16, color: 'var(--muted)' } : undefined}>{k.trim()}</td><td>{v}</td></tr>)}
        {busiest && <tr><td>Jour le plus rempli</td><td>{WEEKDAYS[busiest.weekday]} ({pct(busiest.players / busiest.capacity)})</td></tr>}
        {peakHour && <tr><td>Heure la plus demandée</td><td>{peakHour.hour} h ({peakHour.players} joueurs)</td></tr>}
      </tbody></table>
      <p className="small muted" style={{ margin: 0 }}>Calculés directement par Resa à partir des réservations et des encaissements.</p>
    </div>
  );
}

export function Reports({ user }: { user: User }) {
  const { locale } = useI18n();
  const clubs = useClubs(user, ['org_admin', 'club_admin']);
  const [clubId, setClubId] = useState<string | null>(null);
  const club = clubs.find((c) => c.id === clubId);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState<any>(null);
  const [focus, setFocus] = useState('');
  const [report, setReport] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [aiReady, setAiReady] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { get('/api/ai/status').then((s) => setAiReady(s.configured)); }, []);
  useEffect(() => { if (!clubId && clubs[0]) setClubId(clubs[0].id); }, [clubs]);
  useEffect(() => {
    if (!club) return;
    const today = todayIn(club.timezone);
    setFrom(addDays(today, -6));
    setTo(today);
    get(`/api/clubs/${club.id}/reports`).then((r) => setHistory(r.reports));
  }, [club?.id]);
  useEffect(() => {
    if (!clubId || !from || !to) return;
    setError(null);
    get(`/api/clubs/${clubId}/reports/data?from=${from}&to=${to}`).then(setData).catch((e) => { setData(null); setError(e.message); });
  }, [clubId, from, to]);

  function preset(kind: 'week' | 'month' | 'lastMonth' | 'next7') {
    if (!club) return;
    const today = todayIn(club.timezone);
    const [y, m] = today.split('-').map(Number) as [number, number];
    if (kind === 'week') { setFrom(addDays(today, -6)); setTo(today); }
    if (kind === 'next7') { setFrom(today); setTo(addDays(today, 6)); }
    if (kind === 'month') { setFrom(`${today.slice(0, 7)}-01`); setTo(today); }
    if (kind === 'lastMonth') {
      const first = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
      setFrom(first);
      setTo(addDays(`${today.slice(0, 7)}-01`, -1));
    }
  }

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
    <div className="stack">
      <div className="card row">
        {clubs.length > 1 && (
          <label>Golf<select value={clubId ?? ''} onChange={(e) => { setClubId(e.target.value); setReport(null); }}>
            {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        )}
        <label>Du<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>Au<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <div className="row" style={{ gap: 4 }}>
          <button className="btn sm" onClick={() => preset('week')}>7 derniers jours</button>
          <button className="btn sm" onClick={() => preset('next7')}>7 prochains jours</button>
          <button className="btn sm" onClick={() => preset('month')}>Ce mois</button>
          <button className="btn sm" onClick={() => preset('lastMonth')}>Mois dernier</button>
        </div>
      </div>
      <ErrorBox error={error} />
      <div className="layout">
        <div className="stack">
          <div className="card stack">
            <h2 style={{ margin: 0 }}>Analyse par l'IA</h2>
            {aiReady === false
              ? <p className="small muted" style={{ margin: 0 }}>IA non activée : ajoutez ANTHROPIC_API_KEY dans le fichier .env du serveur. Les chiffres restent disponibles.</p>
              : <>
                  <label>Point à approfondir (facultatif)<input value={focus} onChange={(e) => setFocus(e.target.value)}
                    placeholder="Ex. le remplissage de l'après-midi, les impayés, les caddies…" /></label>
                  <div className="row" style={{ alignItems: 'center' }}>
                    <button className="btn primary" disabled={busy || !data} onClick={generate}>{busy ? 'Rédaction en cours…' : 'Générer le rapport'}</button>
                    <span className="small muted">L'IA reçoit uniquement les chiffres ci-contre (aucune donnée personnelle).</span>
                  </div>
                </>}
          </div>
          {report && (
            <div className="card">
              <div className="small muted">Période du {report.from ?? from} au {report.to ?? to} · {new Date(report.createdAt).toLocaleString()} · {report.model}</div>
              <Markdown text={report.content} />
            </div>
          )}
          {history.length > 0 && (
            <div className="card stack" style={{ gap: 6 }}>
              <h3 style={{ margin: 0 }}>Rapports précédents</h3>
              {history.map((h) => (
                <button key={h.id} className="btn sm" style={{ textAlign: 'start' }}
                  onClick={() => get(`/api/reports/${h.id}`).then((r) => setReport(r.report))}>
                  {h.from} → {h.to}{h.focus ? ` · ${h.focus}` : ''} <span className="muted">· {new Date(h.createdAt).toLocaleDateString()}{h.createdBy ? ` · ${h.createdBy}` : ''}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div>{data && <Figures d={data} />}</div>
      </div>
    </div>
  );
}
