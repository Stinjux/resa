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
import { ChangePassword, Team } from './pages/Team';
import { Members } from './pages/Members';
import { OpenGames } from './pages/OpenGames';
import { Profile } from './pages/Profile';
import { applyTheme, storedTheme, type ThemeChoice } from './theme';
import { NavBar } from './components/NavBar';
import { Reports } from './pages/Reports';
import { Login } from './pages/Login';
import { MyBookings } from './pages/MyBookings';
import { StarterBoard } from './pages/StarterBoard';
import { TeeSheet } from './pages/TeeSheet';

type Page = 'book' | 'sheet' | 'starter' | 'mine' | 'config' | 'assistant' | 'reports' | 'inbox' | 'cash' | 'partner' | 'team' | 'password' | 'open' | 'profile' | 'members' | 'login';

export function hasRole(user: User | null, roles: string[]): boolean {
  return !!user?.roles.some((r) => roles.includes(r.role));
}

type Preferences = { navPinned?: string[]; reportBlocks?: string[] };

function ThemeSwitch() {
  const { t } = useI18n();
  const [choice, setChoice] = useState<ThemeChoice>(storedTheme());
  return (
    <label className="theme-switch"><span className="sr-only">{t('theme.label')}</span>
      <select value={choice} onChange={(e) => { const c = e.target.value as ThemeChoice; setChoice(c); applyTheme(c); }} aria-label={t('theme.label')}>
        <option value="auto">◐ {t('theme.auto')}</option><option value="light">☀ {t('theme.light')}</option><option value="dark">☾ {t('theme.dark')}</option>
      </select>
    </label>
  );
}

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [page, setPage] = useState<Page>('book');
  const [prefs, setPrefs] = useState<Preferences>({});
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
    get<{ preferences: Preferences }>('/api/me/preferences').then((r) => setPrefs(r.preferences)).catch(() => setPrefs({}));
    if (hasRole(u, ['org_admin', 'club_admin', 'receptionist'])) setPage('sheet');
    else if (hasRole(u, ['starter'])) setPage('starter');
    else if (u.partnerId) setPage('partner');
    else if (u.customerId) setPage('mine');
    else setPage('book');
  }

  async function logout() {
    await post('/api/auth/logout').catch(() => undefined);
    setToken(null);
    setUser(null);
    setPrefs({});
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
    ['team', 'Équipe', hasRole(user, ['org_admin', 'club_admin'])],
    ['partner', t('nav.partner'), !!user?.partnerId],
    ['members', 'Membres', hasRole(user, ['org_admin', 'club_admin', 'receptionist'])],
    ['book', t('nav.book'), !user || !!user.customerId],
    ['open', t('nav.openGames'), !!user?.customerId],
    ['mine', t('nav.mine'), !!user?.customerId],
    ['profile', t('nav.profile'), !!user?.customerId],
  ];

  if (!ready) return null;
  return (
    <>
      <header className={`topbar${user?.customerId ? ' golfer-top' : ''}`}>
        <span className="brand"><span className="brand-mark" aria-hidden>⛳</span> Resa Golf</span>
        {!user?.mustChangePassword && (
          <NavBar items={tabs.filter(([, , show]) => show).map(([id, label]) => ({ id, label }))} active={page}
            saved={prefs.navPinned} canSave={!!user} onSelect={(id) => setPage(id as Page)}
            onSaved={(navPinned) => setPrefs({ ...prefs, navPinned })} />
        )}
        <span className="spacer" />
        <ThemeSwitch />
        <LocaleSwitcher />
        {user ? (
          <>
            <span className="who">
              {user.displayName}
              {user.roles.length > 0 && ` · ${[...new Set(user.roles.map((r) => ROLE_LABEL[r.role]))].join(', ')}`}
            </span>
            <button className="btn sm hide-mobile" onClick={() => setPage('password')}>{t('nav.password')}</button>
            <button className="btn sm" onClick={logout}>{t('nav.logout')}</button>
          </>
        ) : (
          <button className="btn sm" onClick={() => setPage('login')}>{t('nav.login')}</button>
        )}
      </header>
      <main>
        {user?.mustChangePassword ? (
          <ChangePassword required onDone={() => get<{ user: User }>('/api/me').then((r) => onLogin(r.user))} />
        ) : <>
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
        {page === 'team' && user && <Team user={user} />}
        {page === 'open' && user && <OpenGames user={user} />}
        {page === 'profile' && user?.customerId && <Profile />}
        {page === 'members' && user && <Members user={user} />}
        {page === 'password' && user && <ChangePassword required={false} onDone={() => undefined} />}
        </>}
      </main>
      {user?.customerId && !user.mustChangePassword && (
        <nav className="bottom-nav">
          {([['book', '⛳', t('nav.book')], ['open', '🤝', t('nav.openGames')], ['mine', '📋', t('nav.mine')], ['profile', '👤', t('nav.profile')]] as Array<[Page, string, string]>)
            .map(([p, icon, label]) => (
              <button key={p} className={page === p ? 'active' : ''} onClick={() => setPage(p)}><span aria-hidden>{icon}</span>{label}</button>
            ))}
        </nav>
      )}
    </>
  );
}
