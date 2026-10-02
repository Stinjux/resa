// Historique global (direction) : qui a fait quoi, quand, sur quel élément.
// Lecture seule : l'historique est écrit par le serveur avec chaque opération.

import { useEffect, useMemo, useState } from 'react';
import { get, type User } from '../api';
import { addDays, todayIn } from '../format';
import { HistoryList, type HistoryEvent } from '../components/resources';
import { ErrorBox, useClubs } from './common';

export function History({ user }: { user: User }) {
  const clubs = useClubs(user, ['org_admin', 'club_admin']);
  const [clubId, setClubId] = useState('');
  const club = clubs.find((c) => c.id === clubId) ?? clubs[0];
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [actorId, setActorId] = useState('');
  const [category, setCategory] = useState('');
  const [reference, setReference] = useState('');
  const [filters, setFilters] = useState<{ actors: Array<{ id: string; name: string }>; categories: Array<{ id: string; label: string }> }>({ actors: [], categories: [] });
  const [events, setEvents] = useState<HistoryEvent[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!club || from) return;
    const today = todayIn(club.timezone);
    setFrom(addDays(today, -6));
    setTo(today);
  }, [club?.id]);
  useEffect(() => {
    if (!clubs.length) return;
    get(`/api/history/filters${clubId ? `?clubId=${clubId}` : ''}`).then(setFilters).catch(() => undefined);
  }, [clubId, clubs.length]);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (clubId) p.set('clubId', clubId);
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (actorId) p.set('actorId', actorId);
    if (category) p.set('category', category);
    if (reference.trim()) p.set('reference', reference.trim());
    return p.toString();
  }, [clubId, from, to, actorId, category, reference]);

  function load(before?: number) {
    setLoading(true);
    setError(null);
    get(`/api/history?${query}${before ? `&before=${before}` : ''}`)
      .then((r) => { setEvents((e) => (before ? [...(e ?? []), ...r.events] : r.events)); setNext(r.next); })
      .catch((e) => { setError(e.message); if (!before) setEvents([]); })
      .finally(() => setLoading(false));
  }
  useEffect(() => {
    if (!from || !to) return;
    const t = setTimeout(() => load(), reference ? 300 : 0);
    return () => clearTimeout(t);
  }, [query]);

  const groups = useMemo(() => {
    const fmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: club?.timezone });
    const m = new Map<string, HistoryEvent[]>();
    for (const e of events ?? []) { const k = fmt.format(new Date(e.at)); m.set(k, [...(m.get(k) ?? []), e]); }
    return [...m.entries()];
  }, [events, club?.timezone]);
  const active = !!(actorId || category || reference);

  return (
    <div className="stack">
      <div className="card stack" style={{ gap: 10 }}>
        <div className="row" style={{ alignItems: 'end' }}>
          {clubs.length > 1 && (
            <label>Golf<select value={clubId} onChange={(e) => { setClubId(e.target.value); setActorId(''); }}>
              <option value="">Tous mes golfs</option>
              {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          )}
          <label>Du<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>Au<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <label>Utilisateur<select value={actorId} onChange={(e) => setActorId(e.target.value)}>
            <option value="">Tous</option>
            {filters.actors.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
          <label>Type d'action<select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">Toutes</option>
            {filters.categories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
          <label>Réservation<input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Ex. G1-000123" style={{ width: 150 }} /></label>
          {active && <button className="btn sm ghost" onClick={() => { setActorId(''); setCategory(''); setReference(''); }}>Effacer les filtres</button>}
        </div>
        <p className="caption muted" style={{ margin: 0 }}>Enregistré automatiquement par le serveur avec chaque opération ; personne ne peut le modifier ni le supprimer.</p>
      </div>
      <ErrorBox error={error} />
      {events === null && <div className="card small muted" aria-live="polite">Chargement de l'historique…</div>}
      {events?.length === 0 && !loading && !error && (
        <div className="card small muted">Aucun événement pour ces filtres{active ? '. Essayez d’élargir la recherche.' : ' sur cette période.'}</div>
      )}
      {groups.map(([day, list]) => (
        <section key={day} className="card stack" style={{ gap: 6 }}>
          <h3 style={{ margin: 0, textTransform: 'capitalize' }}>{day}</h3>
          <HistoryList events={list} showClub={!clubId && clubs.length > 1} timezone={club?.timezone} />
        </section>
      ))}
      {next && <button className="btn" disabled={loading} onClick={() => load(next)} style={{ alignSelf: 'center' }}>{loading ? 'Chargement…' : 'Voir les événements plus anciens'}</button>}
    </div>
  );
}
