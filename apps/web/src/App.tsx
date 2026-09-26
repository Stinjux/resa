import { useEffect, useState } from 'react';
import { get, getToken, post, setToken, type User } from './api';
import { ROLE_LABEL } from './format';
import { BookingFlow } from './pages/BookingFlow';
import { Config } from './pages/Config';
import { Login } from './pages/Login';
import { MyBookings } from './pages/MyBookings';
import { StarterBoard } from './pages/StarterBoard';
import { TeeSheet } from './pages/TeeSheet';

type Page = 'book' | 'sheet' | 'starter' | 'mine' | 'config' | 'login';

export function hasRole(user: User | null, roles: string[]): boolean {
  return !!user?.roles.some((r) => roles.includes(r.role));
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [page, setPage] = useState<Page>('book');
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!getToken()) return setReady(true);
    get<{ user: User }>('/api/me')
      .then((r) => onLogin(r.user))
      .catch(() => setUser(null))
      .finally(() => setReady(true));
  }, []);

  function onLogin(u: User) {
    setUser(u);
    if (hasRole(u, ['org_admin', 'club_admin', 'receptionist'])) setPage('sheet');
    else if (hasRole(u, ['starter'])) setPage('starter');
    else setPage('book');
  }

  async function logout() {
    await post('/api/auth/logout').catch(() => undefined);
    setToken(null);
    setUser(null);
    setPage('book');
  }

  const canSheet = hasRole(user, ['org_admin', 'club_admin', 'receptionist', 'starter']);
  const canStarter = hasRole(user, ['org_admin', 'club_admin', 'starter']);
  const tabs: Array<[Page, string, boolean]> = [
    ['sheet', 'Feuille de départs', canSheet],
    ['starter', 'Starter', canStarter],
    ['config', 'Configuration', hasRole(user, ['org_admin', 'club_admin'])],
    ['book', 'Réserver', !user || !!user.customerId],
    ['mine', 'Mes réservations', !!user?.customerId],
  ];

  if (!ready) return null;
  return (
    <>
      <header className="topbar">
        <span className="brand">⛳ Resa Golf</span>
        <nav className="nav">
          {tabs.filter(([, , show]) => show).map(([p, label]) => (
            <button key={p} className={page === p ? 'active' : ''} onClick={() => setPage(p)}>{label}</button>
          ))}
        </nav>
        <span className="spacer" />
        {user ? (
          <>
            <span className="who">
              {user.displayName}
              {user.roles.length > 0 && ` · ${[...new Set(user.roles.map((r) => ROLE_LABEL[r.role]))].join(', ')}`}
            </span>
            <button className="btn sm" onClick={logout}>Déconnexion</button>
          </>
        ) : (
          <button className="btn sm" onClick={() => setPage('login')}>Connexion</button>
        )}
      </header>
      <main>
        {page === 'login' && <Login onLogin={onLogin} />}
        {page === 'book' && <BookingFlow user={user} onDone={() => user?.customerId && setPage('mine')} />}
        {page === 'sheet' && user && <TeeSheet user={user} />}
        {page === 'starter' && user && <StarterBoard user={user} />}
        {page === 'mine' && user && <MyBookings />}
        {page === 'config' && user && <Config user={user} />}
      </main>
    </>
  );
}
