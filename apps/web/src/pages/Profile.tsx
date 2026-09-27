// Profil du golfeur : coordonnées, index, licence, visibilité dans les
// parties ouvertes, abonnements.

import { useEffect, useState } from 'react';
import { get, patch } from '../api';
import { errorText, useI18n } from '../i18n';
import { ErrorBox } from './common';
import { ChangePassword } from './Team';

export function Profile() {
  const { t } = useI18n();
  const [p, setP] = useState<any>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { get('/api/me/profile').then((r) => setP({ ...r.profile, handicap: r.profile.handicapIndex ?? '' })).catch((e) => setError(errorText(t, e))); }, []);
  if (!p) return <ErrorBox error={error} />;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      const h = String(p.handicap).trim().replace(',', '.');
      const r = await patch('/api/me/profile', {
        firstName: p.firstName || null, lastName: p.lastName, phone: p.phone || null, licenceNumber: p.licenceNumber || null,
        handicapIndex: h === '' ? null : Number(h), shareProfile: p.shareProfile,
      });
      setP({ ...r.profile, handicap: r.profile.handicapIndex ?? '' });
      setSaved(true);
    } catch (err) {
      setError(errorText(t, err));
    }
  }

  return (
    <div className="stack golfer">
      <h1>{t('pf.title')}</h1>
      <form className="card stack" onSubmit={save}>
        <div className="grid2">
          <label>{t('pf.firstName')}<input value={p.firstName ?? ''} onChange={(e) => setP({ ...p, firstName: e.target.value })} /></label>
          <label>{t('pf.lastName')}<input value={p.lastName} required onChange={(e) => setP({ ...p, lastName: e.target.value })} /></label>
          <label>{t('pf.phone')}<input value={p.phone ?? ''} inputMode="tel" onChange={(e) => setP({ ...p, phone: e.target.value })} /></label>
          <label>{t('pf.handicap')}<input value={p.handicap} inputMode="decimal" placeholder="18.4" onChange={(e) => setP({ ...p, handicap: e.target.value })} /></label>
          <label>{t('pf.licence')}<input value={p.licenceNumber ?? ''} onChange={(e) => setP({ ...p, licenceNumber: e.target.value })} /></label>
        </div>
        <label className="check"><input type="checkbox" checked={p.shareProfile} onChange={(e) => setP({ ...p, shareProfile: e.target.checked })} /> {t('pf.share')}</label>
        <ErrorBox error={error} />
        {saved && <div className="alert ok">{t('pf.saved')}</div>}
        <button className="btn primary">{t('pf.save')}</button>
      </form>
      <div className="card stack">
        <h2 style={{ margin: 0 }}>{t('pf.memberships')}</h2>
        {p.memberships.length === 0 && <p className="muted" style={{ margin: 0 }}>{t('pf.noMembership')}</p>}
        {p.memberships.map((m: any) => (
          <div key={m.id} className="member-card">
            <div><strong>{m.clubName}</strong><div className="small">{m.planName}{m.cardNumber && ` · ${t('pf.card', { n: m.cardNumber })}`}</div></div>
            <span className={m.current ? 'badge ok' : 'badge'}>{m.current ? t('pf.validUntil', { date: m.validTo }) : t('pf.inactive')}</span>
          </div>
        ))}
      </div>
      <ChangePassword required={false} onDone={() => undefined} />
    </div>
  );
}
