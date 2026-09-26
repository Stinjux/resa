import { useCallback, useEffect, useState } from 'react';
import { get, post, type User } from '../api';
import { money } from '../format';
import { ErrorBox, useClubs } from './common';

const CHANNEL: Record<string, string> = { whatsapp: 'WhatsApp', sms: 'SMS' };
const AUTHOR: Record<string, string> = { customer: 'Client', ai: 'Assistant IA', staff: 'Personnel', system: 'Message automatique' };

function RequestCard({ r, onDone }: { r: any; onDone: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = r.summary;
  async function act(action: 'approve' | 'reject') {
    if (action === 'reject' && !confirm('Refuser cette demande ? Le client sera prévenu.')) return;
    setBusy(true);
    setError(null);
    try {
      await post(`/api/booking-requests/${r.id}/${action}`, action === 'approve' ? { note: note || null } : { reason: note || null });
      onDone();
    } catch (e) {
      setError((e as Error).message);
      onDone();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={`draft stack ${r.status !== 'pending' ? 'done' : ''}`} style={{ gap: 8 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <strong>Demande de réservation · {CHANNEL[s.channel] ?? s.channel}</strong>
        {r.status === 'pending' && <span className="badge warn">À valider</span>}
        {r.status === 'approved' && <span className="badge ok">Validée : {r.bookingReferences.join(', ')}</span>}
        {r.status === 'rejected' && <span className="badge">Refusée</span>}
      </div>
      <div className="small">Client : <strong>{s.customer}</strong>{s.notes && <> · 📝 {s.notes}</>}</div>
      <table className="lines"><tbody>
        {s.teeTimes.map((t: any, i: number) => (
          <tr key={i}><td><strong>{t.date} à {t.time}</strong> · {t.players} joueur(s) · {t.holes} trous · {t.course}</td><td>{money(t.totalMinor, s.currency)}</td></tr>
        ))}
        <tr className="total"><td>Total TTC</td><td>{money(s.totalMinor, s.currency)}</td></tr>
      </tbody></table>
      {r.lastError && r.status === 'pending' && <div className="alert">Validation impossible : {r.lastError}</div>}
      {r.status !== 'pending' && r.decidedBy && (
        <div className="small muted">{r.status === 'approved' ? 'Validée' : 'Refusée'} par {r.decidedBy} le {new Date(r.decidedAt).toLocaleString()}{r.decisionNote && ` — ${r.decisionNote}`}</div>
      )}
      <ErrorBox error={error} />
      {r.status === 'pending' && (
        <>
          <label>Note (facultatif ; envoyée au client en cas de refus)<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
          <div className="row">
            <button className="btn primary" disabled={busy} onClick={() => act('approve')}>Valider et réserver</button>
            <button className="btn danger" disabled={busy} onClick={() => act('reject')}>Refuser</button>
          </div>
        </>
      )}
    </div>
  );
}

function Simulator({ clubId, onSent }: { clubId: string; onSent: (threadId: string) => void }) {
  const [from, setFrom] = useState('06 12 34 56 78');
  const [name, setName] = useState('');
  const [channel, setChannel] = useState('whatsapp');
  const [text, setText] = useState('Bonjour, je voudrais 2 départs à 13h demain');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function send() {
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ thread: { id: string } }>(`/api/clubs/${clubId}/messaging/simulate`, { channel, from, name: name || null, text });
      setText('');
      onSent(r.thread.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details className="card">
      <summary><strong>Simuler un message client</strong> <span className="small muted">(aucun fournisseur WhatsApp/SMS branché)</span></summary>
      <div className="stack" style={{ marginTop: 10 }}>
        <div className="grid2">
          <label>Canal<select value={channel} onChange={(e) => setChannel(e.target.value)}><option value="whatsapp">WhatsApp</option><option value="sms">SMS</option></select></label>
          <label>Numéro du client<input value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label>Nom (profil WhatsApp)<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        </div>
        <label>Message<textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} /></label>
        <ErrorBox error={error} />
        <button className="btn" disabled={busy || !text.trim()} onClick={send}>{busy ? 'Traitement…' : 'Envoyer comme le client'}</button>
      </div>
    </details>
  );
}

export function Inbox({ user, onChanged }: { user: User; onChanged: () => void }) {
  const clubs = useClubs(user, ['org_admin', 'club_admin', 'receptionist']);
  const [clubId, setClubId] = useState<string | null>(null);
  const [inbox, setInbox] = useState<any>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [thread, setThread] = useState<any>(null);
  const [reply, setReply] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (!clubId && clubs[0]) setClubId(clubs[0].id); }, [clubs]);
  const loadInbox = useCallback(() => {
    if (!clubId) return;
    get(`/api/clubs/${clubId}/inbox`).then(setInbox).catch((e) => setError(e.message));
    onChanged();
  }, [clubId]);
  const loadThread = useCallback(() => {
    if (threadId) get(`/api/message-threads/${threadId}`).then((r) => setThread(r.thread)).catch((e) => setError(e.message));
  }, [threadId]);
  useEffect(() => { loadInbox(); const t = setInterval(loadInbox, 15_000); return () => clearInterval(t); }, [loadInbox]);
  useEffect(() => { loadThread(); const t = setInterval(loadThread, 10_000); return () => clearInterval(t); }, [loadThread]);

  const refresh = () => { loadInbox(); loadThread(); };
  async function sendReply() {
    if (!reply.trim() || !threadId) return;
    try {
      const r = await post(`/api/message-threads/${threadId}/reply`, { text: reply });
      setThread(r.thread);
      setReply('');
      loadInbox();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="stack">
      <div className="card row" style={{ alignItems: 'center' }}>
        {clubs.length > 1 && (
          <label>Golf<select value={clubId ?? ''} onChange={(e) => { setClubId(e.target.value); setThreadId(null); setThread(null); }}>
            {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        )}
        <span className="small muted">Demandes reçues par WhatsApp et SMS. Chaque demande doit être <strong>validée par la réception ou la direction</strong> avant d'être réservée.</span>
      </div>
      <ErrorBox error={error} />
      {inbox && !inbox.provider && <div className="alert">Aucune messagerie configurée pour ce golf (Configuration → Général → Messagerie).</div>}
      {inbox?.simulator && clubId && <Simulator clubId={clubId} onSent={(id) => { setThreadId(id); loadInbox(); }} />}
      <div className="layout" style={{ gridTemplateColumns: 'minmax(260px, 340px) minmax(0, 1fr)' }}>
        <div className="card stack" style={{ gap: 4, padding: 8 }}>
          {inbox?.threads.length === 0 && <p className="muted small" style={{ margin: 8 }}>Aucun message.</p>}
          {inbox?.threads.map((t: any) => (
            <button key={t.id} className="btn" style={{ textAlign: 'start', fontWeight: 400, background: t.id === threadId ? 'var(--accent-soft)' : undefined }}
              onClick={() => setThreadId(t.id)}>
              <div className="row" style={{ justifyContent: 'space-between', gap: 6 }}>
                <strong>{t.contactName ?? t.contact}</strong>
                {t.pendingRequests > 0 && <span className="badge warn">{t.pendingRequests} à valider</span>}
              </div>
              <div className="small muted">{CHANNEL[t.channel]} · {t.contact} · {new Date(t.lastMessageAt).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}</div>
              <div className="small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.lastMessage}</div>
            </button>
          ))}
        </div>
        <div className="card chat" style={{ minHeight: 420 }}>
          {!thread && <p className="muted">Sélectionnez une conversation.</p>}
          {thread && (
            <>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <strong>{thread.contactName ?? thread.contact}</strong>
                <span className="small muted">{CHANNEL[thread.channel]} · {thread.contact}</span>
              </div>
              {thread.messages.map((m: any) => (
                <div key={m.id} className={`bubble ${m.direction === 'in' ? 'assistant' : 'user'}`} title={AUTHOR[m.author]}>
                  <div className="small" style={{ opacity: 0.75 }}>{AUTHOR[m.author]}{m.sentBy && ` · ${m.sentBy}`} · {new Date(m.createdAt).toLocaleTimeString(undefined, { timeStyle: 'short' })}
                    {m.status === 'failed' && ' · ⚠ non envoyé'}{m.status === 'pending' && ' · envoi…'}</div>
                  {m.body}
                </div>
              ))}
              {thread.requests.map((r: any) => <RequestCard key={r.id} r={r} onDone={refresh} />)}
              <form className="composer" onSubmit={(e) => { e.preventDefault(); sendReply(); }}>
                <textarea rows={2} value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Répondre au client…" aria-label="Réponse" />
                <button className="btn primary" disabled={!reply.trim()}>Envoyer</button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
