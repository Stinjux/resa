// Parties ouvertes : départs où des golfeurs cherchent des partenaires.
// On voit l'heure, le parcours, les joueurs (nom abrégé et index s'ils
// l'acceptent) et on rejoint le départ en un geste.

import { useEffect, useState } from 'react';
import { get, post, type User } from '../api';
import { longDate, money } from '../format';
import { errorText, useI18n } from '../i18n';
import { ErrorBox, useClubs } from './common';

export function OpenGames({ user }: { user: User }) {
  const { t } = useI18n();
  const clubs = useClubs(null);
  const [clubId, setClubId] = useState('');
  const [games, setGames] = useState<any[] | null>(null);
  const [joining, setJoining] = useState<any>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => get(`/api/open-games?days=30${clubId ? `&clubId=${clubId}` : ''}`).then((r) => setGames(r.games)).catch((e) => setError(errorText(t, e)));
  useEffect(() => { load(); }, [clubId]);
  if (!user.customerId) return null;

  const byDate = new Map<string, any[]>();
  for (const g of games ?? []) byDate.set(g.date, [...(byDate.get(g.date) ?? []), g]);

  return (
    <div className="stack golfer">
      <div>
        <h1>{t('og.title')}</h1>
        <p className="muted" style={{ margin: 0 }}>{t('og.intro')}</p>
      </div>
      {clubs.length > 1 && (
        <select value={clubId} onChange={(e) => setClubId(e.target.value)} aria-label={t('pt.golf')}>
          <option value="">{t('og.allClubs')}</option>
          {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      )}
      {message && <div className="alert ok">{message}</div>}
      <ErrorBox error={error} />
      {games?.length === 0 && <p className="muted">{t('og.none')}</p>}
      {[...byDate.entries()].map(([date, list]) => (
        <section key={date} className="stack" style={{ gap: 8 }}>
          <h2 style={{ textTransform: 'capitalize', margin: '8px 0 0' }}>{longDate(date)}</h2>
          {list.map((g) => (
            <div key={g.teeTimeId} className="card game">
              <div className="game-head">
                <div className="game-time">{g.localTime}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <strong>{g.clubName}</strong>
                  <div className="small muted">{g.courseName} · {t('og.holes', { n: g.holes })}</div>
                </div>
                <div style={{ textAlign: 'end' }}>
                  <span className="badge ok">{t('og.places', { n: g.remaining })}</span>
                  {g.averageHandicap !== null && <div className="small muted">{t('og.avg', { h: g.averageHandicap })}</div>}
                </div>
              </div>
              <ul className="players">
                {g.bookings.map((b: any, i: number) => (
                  <li key={i}>
                    <span className="avatar">{(b.name ?? '?').slice(0, 1)}</span>
                    <span style={{ flex: 1 }}>{b.name ?? t('og.golfer')}{b.mine && <span className="muted"> ({t('og.you')})</span>}
                      {b.players > 1 && <span className="muted small"> {t('og.guests', { n: b.players - 1 })}</span>}
                      {b.note && <div className="small muted">« {b.note} »</div>}</span>
                    {b.handicapIndex !== null && <span className="hcp">{b.handicapIndex}</span>}
                  </li>
                ))}
                {Array.from({ length: g.remaining }, (_, i) => <li key={`free-${i}`} className="free"><span className="avatar">+</span><span className="muted">—</span></li>)}
              </ul>
              {g.joined ? <span className="badge ok">{t('og.joined')}</span> : (
                <button className="btn primary block" onClick={() => { setJoining({ game: g, players: 1, keepOpen: true }); setMessage(null); }}>{t('og.join')}</button>
              )}
              {joining?.game.teeTimeId === g.teeTimeId && <JoinForm joining={joining} setJoining={setJoining}
                onDone={(ref) => { setJoining(null); setMessage(t('og.done', { ref })); load(); }} />}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

function JoinForm({ joining, setJoining, onDone }: { joining: any; setJoining: (v: any) => void; onDone: (ref: string) => void }) {
  const { t } = useI18n();
  const g = joining.game;
  const [quote, setQuote] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    post('/api/quote', { courseId: g.courseId, startsAt: g.startsAt, players: joining.players, holes: g.holes })
      .then((r) => setQuote(r.quote)).catch((e) => setError(errorText(t, e)));
  }, [joining.players]);
  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const r = await post('/api/bookings', { courseId: g.courseId, startsAt: g.startsAt, players: joining.players, holes: g.holes, isOpen: joining.keepOpen },
        { 'Idempotency-Key': crypto.randomUUID() });
      onDone(r.booking.reference);
    } catch (e) {
      setError(errorText(t, e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack" style={{ gap: 8, marginTop: 8 }}>
      <label>{t('og.players')}<select value={joining.players} onChange={(e) => setJoining({ ...joining, players: Number(e.target.value) })}>
        {Array.from({ length: g.remaining }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}</select></label>
      <label className="check"><input type="checkbox" checked={joining.keepOpen} onChange={(e) => setJoining({ ...joining, keepOpen: e.target.checked })} /> {t('og.keepOpen')}</label>
      {quote && <div>{t('book.total')} : <strong>{money(quote.totalMinor, quote.currency)}</strong></div>}
      <ErrorBox error={error} />
      <div className="row">
        <button className="btn primary" disabled={busy || !quote} onClick={confirm}>{t('og.confirm')}</button>
        <button className="btn" onClick={() => setJoining(null)}>✕</button>
      </div>
    </div>
  );
}
