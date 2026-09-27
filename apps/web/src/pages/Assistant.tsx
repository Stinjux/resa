import { useEffect, useRef, useState } from 'react';
import { get, post } from '../api';
import { money } from '../format';
import { ErrorBox } from './common';

interface Draft {
  id: string;
  status: 'pending' | 'confirmed' | 'cancelled' | 'failed';
  expiresAt: string;
  bookingReferences: string[];
  error: string | null;
  summary: {
    club: string; currency: string; customer: string; isPrivate: boolean; caddiePayment: string; notes: string | null; totalMinor: number;
    teeTimes: Array<{ course: string; date: string; time: string; players: number; holes: number; options: string[]; totalMinor: number; dueOnSiteMinor: number }>;
  };
}
type Item = { kind: 'message'; role: 'user' | 'assistant' | 'system'; text: string } | { kind: 'draft'; draft: Draft };

const KEY = 'resa.ai.conversation';
const SUGGESTIONS = [
  'Book moi 2 départs à 13h demain',
  'Combien de joueurs aujourd’hui et combien de places libres ?',
  'Qui joue à 9h demain ?',
  'Quel est le reste à encaisser cette semaine ?',
];

function DraftCard({ draft, onDecided }: { draft: Draft; onDecided: (d: Draft) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = draft.summary;
  async function decide(action: 'confirm' | 'cancel') {
    setBusy(true);
    setError(null);
    try {
      onDecided((await post<{ draft: Draft }>(`/api/ai/drafts/${draft.id}/${action}`)).draft);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={`draft stack ${draft.status !== 'pending' ? 'done' : ''}`} style={{ gap: 8 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <strong>Réservation à confirmer — {s.club}</strong>
        {draft.status === 'confirmed' && <span className="badge ok">Réservé : {draft.bookingReferences.join(', ')}</span>}
        {draft.status === 'cancelled' && <span className="badge">Abandonné</span>}
        {draft.status === 'failed' && <span className="badge warn">Échec</span>}
      </div>
      <div className="small">Client : <strong>{s.customer}</strong>{s.isPrivate && <span className="badge private"> Privé</span>}
        {' '}· caddie {s.caddiePayment === 'on_site' ? 'payé sur place' : 'payé avec la réservation'}</div>
      <table className="lines"><tbody>
        {s.teeTimes.map((t, i) => (
          <tr key={i}>
            <td><strong>{t.date} à {t.time}</strong> · {t.players} joueur(s) · {t.holes} trous
              {t.options.length > 0 && <span className="muted"> · {t.options.join(', ')}</span>}</td>
            <td>{money(t.totalMinor, s.currency)}</td>
          </tr>
        ))}
        <tr className="total"><td>Total TTC</td><td>{money(s.totalMinor, s.currency)}</td></tr>
      </tbody></table>
      {s.notes && <div className="small">📝 {s.notes}</div>}
      {draft.error && <div className="alert">{draft.error}</div>}
      <ErrorBox error={error} />
      {draft.status === 'pending' && (
        <div className="row">
          <button className="btn primary" disabled={busy} onClick={() => decide('confirm')}>Confirmer la réservation</button>
          <button className="btn" disabled={busy} onClick={() => decide('cancel')}>Abandonner</button>
          <span className="small muted">Valable jusqu'à {new Date(draft.expiresAt).toLocaleTimeString(undefined, { timeStyle: 'short' })}</span>
        </div>
      )}
    </div>
  );
}

export function Assistant() {
  const [status, setStatus] = useState<{ configured: boolean; model: string | null } | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(() => {
    try { return localStorage.getItem(KEY); } catch { return null; }
  });
  const [items, setItems] = useState<Item[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { get('/api/ai/status').then(setStatus); }, []);
  useEffect(() => {
    try { if (conversationId) localStorage.setItem(KEY, conversationId); else localStorage.removeItem(KEY); } catch { /* ignoré */ }
    if (!conversationId) return setItems([]);
    get(`/api/ai/conversations/${conversationId}`)
      .then((r) => {
        // Brouillons affichés après le message qui les a produits (ordre approximatif : fin de conversation).
        const msgs: Item[] = r.transcript.map((m: { role: 'user' | 'assistant'; text: string }) => ({
          kind: 'message', role: m.text.startsWith('[Système]') ? 'system' : m.role, text: m.text.replace(/^\[Système\]\s*/, '') }));
        setItems([...msgs, ...r.drafts.map((d: Draft) => ({ kind: 'draft', draft: d }))]);
      })
      .catch(() => setConversationId(null));
  }, []);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }); }, [items, busy]);

  async function send(message: string) {
    if (!message.trim() || busy) return;
    setBusy(true);
    setError(null);
    setText('');
    setItems((it) => [...it, { kind: 'message', role: 'user', text: message }]);
    try {
      const r = await post<{ conversationId: string; reply: string; drafts: Draft[] }>('/api/ai/assistant', { conversationId, message });
      setConversationId(r.conversationId);
      setItems((it) => [
        ...it,
        ...(r.reply ? [{ kind: 'message' as const, role: 'assistant' as const, text: r.reply }] : []),
        ...r.drafts.map((d) => ({ kind: 'draft' as const, draft: d })),
      ]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function decided(d: Draft) {
    setItems((it) => [
      ...it.map((x) => (x.kind === 'draft' && x.draft.id === d.id ? { kind: 'draft' as const, draft: d } : x)),
      { kind: 'message', role: 'system', text: d.status === 'confirmed' ? `Réservation(s) ${d.bookingReferences.join(', ')} créée(s).` : 'Brouillon abandonné.' },
    ]);
  }

  if (status && !status.configured) {
    return (
      <div className="card stack" style={{ maxWidth: 720 }}>
        <h1>Assistant IA</h1>
        <p>L'assistant n'est pas encore activé sur ce serveur.</p>
        <p className="small muted">Ajoutez la clé API Anthropic dans le fichier <code>.env</code> à la racine du projet
          (<code>ANTHROPIC_API_KEY=…</code>), puis relancez <code>docker compose up</code>.</p>
      </div>
    );
  }

  return (
    <div className="stack" style={{ maxWidth: 900, margin: '0 auto' }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ margin: 0 }}>Assistant IA</h1>
        <button className="btn sm" onClick={() => { setConversationId(null); setItems([]); }}>Nouvelle conversation</button>
      </div>
      <div className="card chat" style={{ minHeight: 360 }}>
        {items.length === 0 && (
          <div className="stack">
            <p className="muted" style={{ margin: 0 }}>Écrivez une demande de réservation ou une question. L'assistant vérifie les disponibilités,
              vous demande ce qui manque, puis prépare la réservation : <strong>rien n'est réservé sans votre confirmation</strong>.</p>
            <div className="chips">{SUGGESTIONS.map((s) => <button key={s} className="btn sm" onClick={() => send(s)}>{s}</button>)}</div>
          </div>
        )}
        {items.map((it, i) => it.kind === 'draft'
          ? <DraftCard key={it.draft.id} draft={it.draft} onDecided={decided} />
          : <div key={i} className={`bubble ${it.role}`}>{it.text}</div>)}
        {busy && <div className="bubble assistant muted">…</div>}
        <div ref={endRef} />
      </div>
      <ErrorBox error={error} />
      <form className="composer" onSubmit={(e) => { e.preventDefault(); send(text); }}>
        <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Ex. book moi 2 départs à 13h le 25 mars pour M. Alami, 4 joueurs, 18 trous"
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(text); } }} rows={2} aria-label="Message" />
        <button className="btn" disabled={busy || !text.trim()}>Envoyer</button>
      </form>
      {status?.model && <p className="small muted" style={{ margin: 0 }}>Modèle : {status.model}. Les demandes sont traitées par l'API d'Anthropic.</p>}
    </div>
  );
}
