// Page interne /styleguide : palette, typographie et composants du thème,
// affichés côte à côte en clair et en sombre (data-theme sur chaque colonne).

import { useState } from 'react';
import { Calendar, PlayersStepper, SlotLegend, StatusBadge, Stepper, TeeSlot, type CalendarDay } from '../components/ui';

const COLORS: Array<[string, string[]]> = [
  ['Neutres', ['color-bg', 'color-surface', 'color-surface-muted', 'color-border', 'color-border-strong', 'color-border-control', 'color-text', 'color-text-muted', 'color-text-disabled']],
  ['Primaire', ['color-primary', 'color-primary-hover', 'color-primary-active', 'color-primary-subtle', 'color-on-primary']],
  ['Accent (membres / premium)', ['color-accent', 'color-accent-text', 'color-accent-subtle']],
  ['Sémantiques', ['color-success', 'color-success-subtle', 'color-warning', 'color-warning-subtle', 'color-danger', 'color-danger-subtle', 'color-info', 'color-info-subtle']],
];

const SLOTS = [
  { label: 'Disponible', slot: { startsAt: '1', localTime: '08:00', remaining: 4, state: 'available' as const } },
  { label: 'Presque complet', slot: { startsAt: '2', localTime: '08:08', remaining: 1, state: 'available' as const } },
  { label: 'Sélectionné', slot: { startsAt: '3', localTime: '08:16', remaining: 3, state: 'available' as const }, selected: true },
  { label: 'Complet', slot: { startsAt: '4', localTime: '08:24', remaining: 0, state: 'full' as const } },
  { label: 'Bloqué', slot: { startsAt: '5', localTime: '08:32', remaining: 0, state: 'blocked' as const, reason: 'Compétition' } },
  { label: 'Membres', slot: { startsAt: '6', localTime: '08:40', remaining: 4, state: 'available' as const, membersOnly: true } },
  { label: 'Tarif réduit', slot: { startsAt: '7', localTime: '15:20', remaining: 4, state: 'available' as const, discountPercent: 20 } },
];

function Panel({ theme }: { theme: 'light' | 'dark' }) {
  const [players, setPlayers] = useState(2);
  const [day, setDay] = useState('2026-10-14');
  const days = new Map<string, CalendarDay>(Array.from({ length: 31 }, (_, i) => {
    const date = `2026-10-${String(i + 1).padStart(2, '0')}`;
    return [date, { date, available: i % 9 === 4 ? 0 : 20, deal: i % 7 === 2 }];
  }));
  return (
    <section data-theme={theme} className="sg-theme stack" style={{ gap: 20 }}>
      <h2>{theme === 'light' ? 'Mode clair' : 'Mode sombre'}</h2>

      <div className="stack" style={{ gap: 10 }}>
        <h3>Palette</h3>
        {COLORS.map(([group, names]) => (
          <div key={group}>
            <div className="small muted" style={{ marginBottom: 6 }}>{group}</div>
            <div className="sg-swatches">
              {names.map((n) => (
                <div key={n} className="sg-swatch"><div style={{ background: `var(--${n})` }} /><div className="mono">--{n}</div></div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="card stack" style={{ gap: 6 }}>
        <h3>Typographie</h3>
        <h1 style={{ margin: 0 }}>Titre h1 · Newsreader 44</h1>
        <h2 style={{ margin: 0 }}>Titre h2 · Newsreader 22</h2>
        <h3 style={{ margin: 0 }}>Titre h3 · Newsreader 18</h3>
        <p style={{ margin: 0 }}>Texte courant 15 px, police d'interface. Le serif est réservé aux titres.</p>
        <p className="small muted" style={{ margin: 0 }}>Small 13 px, texte secondaire</p>
        <p className="caption muted" style={{ margin: 0 }}>Caption 12 px</p>
        <p style={{ margin: 0 }}><span className="num">08:00 · 08:08 · 11:52</span> — chiffres tabulaires · <code>G1-000123 · #1F5A43</code></p>
      </div>

      <div className="card stack">
        <h3>Boutons</h3>
        <div className="row" style={{ alignItems: 'center' }}>
          <button className="btn primary">Réserver</button>
          <button className="btn">Secondaire</button>
          <button className="btn ghost">Ghost</button>
          <button className="btn danger">Annuler la réservation</button>
          <button className="btn danger-solid">Oui, annuler</button>
          <button className="btn primary" disabled>Désactivé</button>
          <button className="btn sm">Petit</button>
        </div>
      </div>

      <div className="card stack">
        <h3>Champs</h3>
        <div className="grid2">
          <label>Nom<input placeholder="Ex. Benali" /></label>
          <label>E-mail<input defaultValue="karim@" aria-invalid="true" /><span className="field-error">Adresse e-mail invalide</span></label>
          <label>Parcours<select><option>Parcours 18 trous</option></select></label>
          <label>Désactivé<input disabled defaultValue="Non modifiable" /></label>
        </div>
        <label className="check"><input type="checkbox" defaultChecked /> Case à cocher</label>
      </div>

      <div className="card stack">
        <h3>Badges et alertes</h3>
        <div className="row" style={{ alignItems: 'center' }}>
          <StatusBadge status="confirmed" /><StatusBadge status="pending" /><StatusBadge status="cancelled" /><StatusBadge status="done" />
          <span className="badge member">★ Membre</span><span className="badge success">−20 %</span><span className="badge private">Privé</span>
        </div>
        <div className="alert ok">Réservation confirmée.</div>
        <div className="alert">Ce créneau vient d'être pris.</div>
        <div className="alert info">Le caddie est partagé entre les joueurs du départ.</div>
      </div>

      <div className="card stack">
        <h3>Créneaux (7 états)</h3>
        <SlotLegend />
        <div className="slots">
          {SLOTS.map((s) => (
            <div key={s.label} className="stack" style={{ gap: 4 }}>
              <TeeSlot slot={s.slot} players={players} selected={!!s.selected} onSelect={() => undefined} />
              <span className="caption muted" style={{ textAlign: 'center' }}>{s.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="card stack">
        <h3>Stepper et calendrier</h3>
        <Stepper steps={['Date', 'Créneau', 'Joueurs', 'Paiement']} current={1} onGo={() => undefined} />
        <Calendar month="2026-10" onMonth={() => undefined} days={days} selected={day} today="2026-10-09" onSelect={setDay} locale="fr-FR" />
      </div>

      <div className="recap-bar" style={{ position: 'static' }}>
        <button className="btn ghost">‹ Retour</button>
        <div className="stack" style={{ gap: 0, flex: 1 }}><span className="recap-when">Mercredi 14 octobre · 08:16</span><span className="small muted">18 trous</span></div>
        <PlayersStepper value={players} onChange={setPlayers} />
        <span className="recap-total">2 800 MAD</span>
        <button className="btn primary">Continuer</button>
      </div>
    </section>
  );
}

export function Styleguide() {
  return (
    <main className="stack" style={{ maxWidth: 1600 }}>
      <div>
        <h1>Styleguide Resa Golf</h1>
        <p className="muted">Tokens : <code>apps/web/src/theme.css</code> · contrastes : <code>docs/THEME.md</code> (<code>node scripts/contrast.mjs</code>).</p>
      </div>
      <div className="sg-grid">
        <Panel theme="light" />
        <Panel theme="dark" />
      </div>
    </main>
  );
}
