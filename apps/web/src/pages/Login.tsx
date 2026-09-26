import { useState } from 'react';
import { post, setToken, type User } from '../api';
import { errorText, useI18n } from '../i18n';
import { useClubs } from './common';

const DEMO = [
  ['reception.g1@demo.ma', 'Réception G1'],
  ['starter.g1@demo.ma', 'Starter G1'],
  ['direction.g1@demo.ma', 'Direction G1'],
  ['admin@demo.ma', 'Admin groupe'],
  ['client@demo.ma', 'Client'],
];

export function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const { t } = useI18n();
  const clubs = useClubs(null);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState({ email: '', password: '', firstName: '', lastName: '', phone: '', clubId: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value });

  async function submit(e?: React.FormEvent, creds?: { email: string; password: string }) {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = mode === 'register' && !creds
        ? await post<{ token: string; user: User }>('/api/auth/register', {
            email: form.email, password: form.password, firstName: form.firstName || null, lastName: form.lastName,
            phone: form.phone || null, clubId: form.clubId || clubs[0]?.id,
          })
        : await post<{ token: string; user: User }>('/api/auth/login', creds ?? { email: form.email, password: form.password });
      setToken(r.token);
      onLogin(r.user);
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card stack" style={{ maxWidth: 440, margin: '40px auto' }}>
      <h1>{mode === 'login' ? t('login.title') : t('register.title')}</h1>
      <form className="stack" onSubmit={submit}>
        {mode === 'register' && (
          <>
            {clubs.length > 1 && (
              <label>{t('book.golf')}<select value={form.clubId || clubs[0]?.id} onChange={set('clubId')}>
                {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            )}
            <div className="grid2">
              <label>{t('book.firstName')}<input value={form.firstName} onChange={set('firstName')} autoComplete="given-name" /></label>
              <label>{t('book.lastName')}<input value={form.lastName} onChange={set('lastName')} autoComplete="family-name" required /></label>
            </div>
            <label>{t('book.phone')}<input type="tel" value={form.phone} onChange={set('phone')} autoComplete="tel" /></label>
          </>
        )}
        <label>{t('login.email')}<input type="email" value={form.email} onChange={set('email')} autoComplete="username" required /></label>
        <label>{t('login.password')}<input type="password" value={form.password} onChange={set('password')} minLength={mode === 'register' ? 8 : undefined}
          autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required /></label>
        {error && <div className="alert" role="alert">{error}</div>}
        <button className="btn primary" disabled={busy}>{mode === 'login' ? t('login.submit') : t('register.submit')}</button>
      </form>
      <div className="small">
        {mode === 'login'
          ? <>{t('login.noAccount')} <a href="#" onClick={(e) => { e.preventDefault(); setMode('register'); setError(null); }}>{t('login.register')}</a></>
          : <>{t('register.haveAccount')} <a href="#" onClick={(e) => { e.preventDefault(); setMode('login'); setError(null); }}>{t('login.submit')}</a></>}
      </div>
      {import.meta.env.VITE_DEMO !== 'false' && mode === 'login' && <div className="demo-accounts muted">
        <div>{t('login.demo', { pw: 'Demo2026!' })}</div>
        {DEMO.map(([mail, label]) => (
          <button key={mail} className="btn sm" disabled={busy} onClick={() => submit(undefined, { email: mail, password: 'Demo2026!' })}>
            {label}
          </button>
        ))}
      </div>}
    </div>
  );
}
