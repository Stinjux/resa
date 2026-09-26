// Équipe : comptes du personnel (direction, administrateur du groupe) et
// changement de son propre mot de passe (tout compte).

import { useEffect, useState } from 'react';
import { get, patch, post, type User } from '../api';
import { ROLE_LABEL } from '../format';
import { errorText, useI18n } from '../i18n';
import { ErrorBox, useClubs } from './common';

type Grant = { clubId: string | null; role: string };

export function Team({ user }: { user: User }) {
  const isOrgAdmin = user.roles.some((r) => r.role === 'org_admin' && r.clubId === null);
  const clubs = useClubs(user, ['org_admin', 'club_admin']);
  const clubName = (id: string | null) => (id ? clubs.find((c) => c.id === id)?.name ?? '—' : 'Tous les golfs');
  const [users, setUsers] = useState<any[]>([]);
  const [editing, setEditing] = useState<any | null>(null);
  const [secret, setSecret] = useState<{ email: string; password: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => get('/api/staff-users').then((r) => setUsers(r.users)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function run(fn: () => Promise<void>) {
    setError(null);
    try { await fn(); load(); } catch (e) { setError((e as Error).message); }
  }
  const reset = (u: any) => {
    if (!window.confirm(`Réinitialiser le mot de passe de ${u.displayName} ? Ses sessions seront fermées.`)) return;
    run(async () => { const r = await post(`/api/staff-users/${u.id}/reset-password`); setSecret({ email: u.email, password: r.temporaryPassword }); });
  };

  return (
    <div className="stack">
      <div className="card stack">
        <div className="row">
          <h2 style={{ margin: 0 }}>Équipe</h2>
          <span className="spacer" />
          <button className="btn sm primary" onClick={() => { setEditing({ isNew: true, email: '', displayName: '', roles: [{ clubId: clubs[0]?.id ?? null, role: 'receptionist' }] }); setSecret(null); }}>
            + Nouveau compte</button>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          {isOrgAdmin ? 'Tous les comptes du personnel du groupe.' : 'Comptes du personnel de vos golfs. Un compte ayant aussi des droits sur un autre golf est géré par l’administrateur du groupe.'}
          {' '}Chaque nouveau compte reçoit un mot de passe provisoire, à changer à la première connexion.
        </p>
        {secret && (
          <div className="alert ok">
            Mot de passe provisoire de <strong>{secret.email}</strong> : <code style={{ fontSize: 16 }}>{secret.password}</code>
            <div className="small">Communiquez-le à la personne ; il ne sera plus affiché. Elle devra le changer à sa première connexion.</div>
          </div>
        )}
        <ErrorBox error={error} />
        {editing && <UserForm value={editing} clubs={clubs} isOrgAdmin={isOrgAdmin} onCancel={() => setEditing(null)}
          onSave={async (v) => {
            if (v.isNew) {
              const r = await post('/api/staff-users', { email: v.email, displayName: v.displayName, roles: v.roles });
              setSecret({ email: v.email, password: r.temporaryPassword });
            } else {
              await patch(`/api/staff-users/${v.id}`, { displayName: v.displayName, roles: v.roles });
            }
            setEditing(null);
            load();
          }} />}
      </div>
      <div className="card table-wrap">
        <table className="sheet">
          <thead><tr><th>Nom</th><th>E-mail</th><th>Rôles</th><th>Dernière connexion</th><th>État</th><th /></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={u.active ? '' : 'muted'}>
                <td><strong>{u.displayName}</strong>{u.id === user.userId && <span className="badge"> vous</span>}</td>
                <td className="small">{u.email}</td>
                <td className="small">{u.roles.map((g: Grant) => `${ROLE_LABEL[g.role]} · ${clubName(g.clubId)}`).join(', ')}</td>
                <td className="small">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : 'jamais'}</td>
                <td>{!u.active ? <span className="badge warn">désactivé</span> : u.mustChangePassword ? <span className="badge">mot de passe provisoire</span> : <span className="badge ok">actif</span>}</td>
                <td className="row">
                  {u.editable ? <>
                    <button className="btn sm" onClick={() => { setEditing({ ...u }); setSecret(null); }}>Modifier</button>
                    <button className="btn sm" onClick={() => reset(u)}>Mot de passe</button>
                    {u.id !== user.userId && (u.active
                      ? <button className="btn sm danger" onClick={() => window.confirm(`Désactiver ${u.displayName} ? Il sera déconnecté immédiatement.`)
                          && run(() => patch(`/api/staff-users/${u.id}`, { active: false }))}>Désactiver</button>
                      : <button className="btn sm" onClick={() => run(() => patch(`/api/staff-users/${u.id}`, { active: true }))}>Réactiver</button>)}
                  </> : <span className="small muted">géré par le groupe</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function UserForm({ value, clubs, isOrgAdmin, onSave, onCancel }: {
  value: any; clubs: Array<{ id: string; name: string }>; isOrgAdmin: boolean; onSave: (v: any) => Promise<void>; onCancel: () => void;
}) {
  const [v, setV] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const roleOptions = Object.entries(ROLE_LABEL).filter(([r]) => isOrgAdmin || r !== 'org_admin');
  const setGrant = (i: number, g: Partial<Grant>) => {
    const roles = v.roles.map((x: Grant, j: number) => {
      if (j !== i) return x;
      const next = { ...x, ...g };
      // L'administrateur du groupe couvre tous les golfs ; les autres rôles portent sur un golf.
      if (next.role === 'org_admin') next.clubId = null;
      else if (!next.clubId) next.clubId = clubs[0]?.id ?? null;
      return next;
    });
    setV({ ...v, roles });
  };
  async function save() {
    setBusy(true);
    setError(null);
    try { await onSave(v); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="card stack" style={{ background: 'var(--surface-2)' }}>
      <div className="grid2">
        <label>Nom affiché<input value={v.displayName} onChange={(e) => setV({ ...v, displayName: e.target.value })} /></label>
        <label>E-mail de connexion<input value={v.email} disabled={!v.isNew} onChange={(e) => setV({ ...v, email: e.target.value })} /></label>
      </div>
      <strong className="small">Rôles</strong>
      {v.roles.map((g: Grant, i: number) => (
        <div key={i} className="row">
          <select value={g.role} onChange={(e) => setGrant(i, { role: e.target.value })}>
            {roleOptions.map(([r, l]) => <option key={r} value={r}>{l}</option>)}</select>
          {g.role !== 'org_admin' && (
            <select value={g.clubId ?? ''} onChange={(e) => setGrant(i, { clubId: e.target.value })}>
              {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
          )}
          {v.roles.length > 1 && <button className="btn sm" onClick={() => setV({ ...v, roles: v.roles.filter((_: Grant, j: number) => j !== i) })}>Retirer</button>}
        </div>
      ))}
      <div><button className="btn sm" onClick={() => setV({ ...v, roles: [...v.roles, { clubId: clubs[0]?.id ?? null, role: 'receptionist' }] })}>+ Rôle</button></div>
      <p className="small muted" style={{ margin: 0 }}>
        Direction : tout sur son golf (configuration, rapports, caisse, avoirs, équipe). Réception : réservations, clients, caisse.
        Starter : départs du jour et de la semaine, caddies, matériel, arrivées.
      </p>
      <ErrorBox error={error} />
      <div className="row">
        <button className="btn primary" disabled={busy || !v.displayName.trim() || !v.email.trim()} onClick={save}>{v.isNew ? 'Créer le compte' : 'Enregistrer'}</button>
        <button className="btn" onClick={onCancel}>Annuler</button>
      </div>
    </div>
  );
}

export function ChangePassword({ required, onDone }: { required: boolean; onDone: () => void }) {
  const { t } = useI18n();
  const [f, setF] = useState({ current: '', next: '', confirm: '' });
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (f.next !== f.confirm) return setError(t('pwd.mismatch'));
    setBusy(true);
    setError(null);
    try {
      await post('/api/me/password', { current: f.current, next: f.next });
      setOk(true);
      setF({ current: '', next: '', confirm: '' });
      onDone();
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="card stack" style={{ maxWidth: 460, margin: '0 auto' }} onSubmit={submit}>
      <h2 style={{ margin: 0 }}>{t('pwd.title')}</h2>
      {required && <div className="alert">{t('pwd.required')}</div>}
      <label>{t('pwd.current')}<input type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></label>
      <label>{t('pwd.next')}<input type="password" autoComplete="new-password" minLength={10} value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} /></label>
      <label>{t('pwd.confirm')}<input type="password" autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} /></label>
      <ErrorBox error={error} />
      {ok && <div className="alert ok">{t('pwd.done')}</div>}
      <button className="btn primary" disabled={busy || !f.current || f.next.length < 10}>{t('pwd.submit')}</button>
    </form>
  );
}
