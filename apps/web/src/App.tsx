import { useEffect, useState } from 'react';
import { get, getToken, post, setToken, type User } from './api';
import { ROLE_LABEL } from './format';
import { LocaleSwitcher, useI18n } from './i18n';
import { BookingFlow } from './pages/BookingFlow';
import { Assistant } from './pages/Assistant';
import { Config } from './pages/Config';
import { Inbox } from './pages/Inbox';
import { Cash } from './pages/Cash';
import { PartnerPortal } from './pages/PartnerPortal';
import { Reports } from './pages/Reports';
import { Login } from './pages/Login';
import { MyBookings } from './pages/MyBookings';
import { StarterBoard } from './pages/StarterBoard';
import { TeeSheet } from './pages/TeeSheet';

type Page = 'book' | 'sheet' | 'starter' | 'mine' | 'config' | 'assistant' | 'reports' | 'inbox' | 'cash' | 'partner' | 'login';

export function hasRole(user: User | null, roles: string[]): boolean {
  return !!user?.roles.some((r) => roles.includes(r.role));
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [page, setPage] = useState<Page>('book');
  const [ready, setReady] = useState(false);
  const { t } = useI18n();
  const [pending, setPending] = useState(0);
  const canValidate = hasRole(user, ['org_admin', 'club_admin', 'receptionist']);
  const refreshPending = () => { if (canValidate) get<{ count: number }>('/api/booking-requests/pending-count').then((r) => setPending(r.count)).catch(() => undefined); };
  useEffect(() => { refreshPending(); const id = setInterval(refreshPending, 30_000); return () => clearInterval(id); }, [user]);

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
    else if (u.partnerId) setPage('partner');
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
    ['sheet', t('nav.sheet'), canSheet],
    ['starter', t('nav.starter'), canStarter],
    ['inbox', pending ? `Demandes (${pending})` : 'Demandes', canValidate],
    ['cash', 'Caisse', hasRole(user, ['org_admin', 'club_admin', 'receptionist'])],
    ['assistant', 'Assistant IA', canSheet],
    ['reports', 'Rapports', hasRole(user, ['org_admin', 'club_admin'])],
    ['config', t('nav.config'), hasRole(user, ['org_admin', 'club_admin'])],
    ['partner', t('nav.partner'), !!user?.partnerId],
    ['book', t('nav.book'), !user || !!user.customerId],
    ['mine', t('nav.mine'), !!user?.customerId],
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
        <LocaleSwitcher />
        {user ? (
          <>
            <span className="who">
              {user.displayName}
              {user.roles.length > 0 && ` · ${[...new Set(user.roles.map((r) => ROLE_LABEL[r.role]))].join(', ')}`}
            </span>
            <button className="btn sm" onClick={logout}>{t('nav.logout')}</button>
          </>
        ) : (
          <button className="btn sm" onClick={() => setPage('login')}>{t('nav.login')}</button>
        )}
      </header>
      <main>
        {page === 'login' && <Login onLogin={onLogin} />}
        {page === 'book' && <BookingFlow user={user} onDone={() => user?.customerId && setPage('mine')} />}
        {page === 'sheet' && user && <TeeSheet user={user} />}
        {page === 'starter' && user && <StarterBoard user={user} />}
        {page === 'mine' && user && <MyBookings />}
        {page === 'config' && user && <Config user={user} />}
        {page === 'assistant' && user && <Assistant />}
        {page === 'inbox' && user && <Inbox user={user} onChanged={refreshPending} />}
        {page === 'reports' && user && <Reports user={user} />}
        {page === 'cash' && user && <Cash user={user} />}
        {page === 'partner' && user?.partnerId && <PartnerPortal user={user} />}
      </main>
    </>
  );
}
