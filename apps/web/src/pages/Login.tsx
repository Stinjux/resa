import { useState } from 'react';
import { post, setToken, type User } from '../api';

const DEMO = [
  ['reception.g1@demo.ma', 'Réception G1'],
  ['starter.g1@demo.ma', 'Starter G1'],
  ['direction.g1@demo.ma', 'Direction G1'],
  ['admin@demo.ma', 'Admin groupe'],
  ['client@demo.ma', 'Client'],
];

export function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e?: React.FormEvent, creds?: { email: string; password: string }) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ token: string; user: User }>('/api/auth/login', creds ?? { email, password });
      setToken(r.token);
      onLogin(r.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack" style={{ maxWidth: 420, margin: '40px auto' }}>
      <h1>Connexion</h1>
      <form className="stack" onSubmit={submit}>
        <label>E-mail<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required /></label>
        <label>Mot de passe<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></label>
        {error && <div className="alert">{error}</div>}
        <button className="btn primary" disabled={busy}>Se connecter</button>
      </form>
      {import.meta.env.VITE_DEMO !== 'false' && <div className="demo-accounts muted">
        <div>Comptes de démonstration (mot de passe <code>Demo2026!</code>) :</div>
        {DEMO.map(([mail, label]) => (
          <button key={mail} className="btn sm" disabled={busy} onClick={() => submit(undefined, { email: mail, password: 'Demo2026!' })}>
            {label}
          </button>
        ))}
      </div>}
    </div>
  );
}
