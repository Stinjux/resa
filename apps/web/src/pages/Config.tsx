import { useCallback, useEffect, useState } from 'react';
import { get, patch, post, put, type User } from '../api';
import { addDays, money, todayIn } from '../format';
import { EntityForm, weekdaysLabel, type Field } from './EntityForm';
import { ErrorBox, useClubs } from './common';

type Tab = 'general' | 'schedule' | 'tariffs' | 'resources';

export function Config({ user }: { user: User }) {
  const clubs = useClubs(user, ['org_admin', 'club_admin']);
  const [clubId, setClubId] = useState<string | null>(null);
  const [cfg, setCfg] = useState<any>(null);
  const [tab, setTab] = useState<Tab>('general');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (!clubId && clubs[0]) setClubId(clubs[0].id); }, [clubs]);
  const load = useCallback(() => {
    if (!clubId) return;
    get(`/api/clubs/${clubId}/config`).then(setCfg).catch((e) => setError(e.message));
  }, [clubId]);
  useEffect(load, [load]);

  const base = `/api/clubs/${clubId}/config`;
  const save = (entity: string, id: string | null) => async (values: Record<string, unknown>) => {
    if (id) await patch(`${base}/${entity}/${id}`, values);
    else await post(`${base}/${entity}`, values);
    load();
  };

  return (
    <div className="stack">
      <div className="card row">
        {clubs.length > 1 && (
          <label>Golf<select value={clubId ?? ''} onChange={(e) => { setClubId(e.target.value); setCfg(null); }}>
            {clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        )}
        <nav className="nav">
          {([['general', 'Général'], ['schedule', 'Parcours & horaires'], ['tariffs', 'Tarifs'], ['resources', 'Caddies & matériel']] as Array<[Tab, string]>)
            .map(([t, l]) => <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{l}</button>)}
        </nav>
      </div>
      <ErrorBox error={error} />
      {cfg && tab === 'general' && <General cfg={cfg} onSave={async (v) => { await patch(base, v); load(); }} />}
      {cfg && tab === 'schedule' && <Schedule cfg={cfg} base={base} save={save} />}
      {cfg && tab === 'tariffs' && <Tariffs cfg={cfg} save={save} />}
      {cfg && tab === 'resources' && <Resources cfg={cfg} base={base} save={save} reload={load} />}
    </div>
  );
}

type Save = (entity: string, id: string | null) => (values: Record<string, unknown>) => Promise<void>;

// ---------------------------------------------------------------------------

function General({ cfg, onSave }: { cfg: any; onSave: (v: Record<string, unknown>) => Promise<void> }) {
  const [saved, setSaved] = useState(false);
  const c = cfg.club;
  const fields: Field[] = [
    { key: 'name', label: 'Nom du golf', type: 'text', nullable: false },
    { key: 'timezone', label: 'Fuseau horaire', type: 'text', nullable: false, hint: 'Ex. Africa/Casablanca, Europe/Paris' },
    { key: 'currency', label: 'Devise', type: 'text', nullable: false, hint: 'Code ISO : MAD, EUR…' },
    { key: 'defaultLocale', label: 'Langue par défaut', type: 'select', options: [['fr', 'Français'], ['en', 'English'], ['ar', 'العربية'], ['es', 'Español']] },
    { key: 'taxRate', label: 'TVA (%)', type: 'text', nullable: false },
    { key: 'pricesIncludeTax', label: 'Prix saisis TTC', type: 'checkbox' },
    { key: 'bookingHorizonDays', label: 'Réservation en ligne jusqu\'à (jours)', type: 'number' },
    { key: 'minLeadMinutes', label: 'Délai minimal en ligne (minutes)', type: 'number' },
    { key: 'defaultCaddiePayment', label: 'Paiement du caddie par défaut', type: 'select', options: [['on_site', 'Sur place'], ['with_booking', 'Avec la réservation']] },
    { key: 'caddieFeeSplit', label: 'Caddie d\'un départ partagé', type: 'select', options: [
      ['pro_rata_players', 'Réparti au prorata des joueurs'], ['equal', 'Réparti à parts égales'], ['first_booking', 'Payé par la 1re réservation']] },
  ];
  return (
    <div className="card stack" style={{ maxWidth: 900 }}>
      <h2>Paramètres du golf <span className="badge">{c.code}</span></h2>
      <EntityForm key={JSON.stringify(c)} fields={fields} isNew={false} initial={{ ...c, taxRate: String(c.taxRateBp / 100) }}
        onSubmit={async (v) => {
          const { taxRate, ...rest } = v;
          await onSave({ ...rest, taxRateBp: Math.round(Number(String(taxRate).replace(',', '.')) * 100) });
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
        }} />
      {saved && <div className="alert ok">Enregistré.</div>}
      <p className="small muted">Le caddie coûte un prix unique par départ (voir « Caddies & matériel ») ; ce réglage indique comment le répartir entre plusieurs réservations d'un même départ.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Editable({ title, items, render, fields, entity, save, newValues, columns }: {
  title: string; items: any[]; columns: string[]; render: (item: any) => React.ReactNode[];
  fields: Field[]; entity: string; save: Save; newValues: Record<string, unknown>;
}) {
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ margin: 0 }}>{title}</h2>
        <button className="btn sm primary" onClick={() => setEditing('new')}>+ Ajouter</button>
      </div>
      {editing === 'new' && (
        <div className="card" style={{ background: 'var(--surface-2)' }}>
          <EntityForm fields={fields} isNew initial={newValues}
            onSubmit={async (v) => { await save(entity, null)(v); setEditing(null); }} onCancel={() => setEditing(null)} />
        </div>
      )}
      <div className="table-wrap">
        <table className="sheet">
          <thead><tr>{columns.map((c) => <th key={c}>{c}</th>)}<th /></tr></thead>
          <tbody>
            {items.map((item) => editing === item.id ? (
              <tr key={item.id}><td colSpan={columns.length + 1} style={{ background: 'var(--surface-2)' }}>
                <EntityForm fields={fields} isNew={false} initial={item}
                  onSubmit={async (v) => { await save(entity, item.id)(v); setEditing(null); }} onCancel={() => setEditing(null)} />
              </td></tr>
            ) : (
              <tr key={item.id} style={{ opacity: item.active === false || item.status === 'retired' ? 0.5 : 1 }}>
                {render(item).map((cell, i) => <td key={i}>{cell}</td>)}
                <td style={{ textAlign: 'right' }}><button className="btn sm" onClick={() => setEditing(item.id)}>Modifier</button></td>
              </tr>
            ))}
            {items.length === 0 && <tr><td colSpan={columns.length + 1} className="muted">Aucun élément.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function courseOptions(cfg: any, all = 'Tous les parcours'): Array<[string, string]> {
  return [['', all], ...cfg.courses.map((c: any) => [c.id, c.name] as [string, string])];
}

function Schedule({ cfg, base, save }: { cfg: any; base: string; save: Save }) {
  const courseFields: Field[] = [
    { key: 'code', label: 'Code', type: 'text', createOnly: true, nullable: false },
    { key: 'name', label: 'Nom', type: 'text', nullable: false },
    { key: 'allowedHoles', label: 'Formules proposées', type: 'holes' },
    { key: 'defaultIntervalMinutes', label: 'Intervalle par défaut (min)', type: 'number' },
    { key: 'defaultMaxPlayers', label: 'Joueurs max par départ', type: 'select', options: [['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']] },
    { key: 'playMinutes9', label: 'Durée de jeu 9 trous (min)', type: 'number', hint: 'Occupation du caddie et du matériel' },
    { key: 'playMinutes18', label: 'Durée de jeu 18 trous (min)', type: 'number' },
    { key: 'active', label: 'Actif', type: 'checkbox' },
  ];
  const ruleFields: Field[] = [
    { key: 'name', label: 'Nom', type: 'text', nullable: false },
    { key: 'kind', label: 'Type', type: 'select', options: [['open', 'Ouverture'], ['closed', 'Fermeture']] },
    { key: 'courseId', label: 'Parcours', type: 'select', options: courseOptions(cfg) },
    { key: 'startTime', label: 'De', type: 'time' },
    { key: 'endTime', label: 'À (exclu)', type: 'time' },
    { key: 'validFrom', label: 'Du (date)', type: 'date' },
    { key: 'validTo', label: 'Au (date)', type: 'date' },
    { key: 'weekdays', label: 'Jours', type: 'weekdays', hint: 'Aucun coché = tous les jours' },
    { key: 'intervalMinutes', label: 'Intervalle (min)', type: 'number', hint: 'Vide = celui du parcours' },
    { key: 'maxPlayers', label: 'Joueurs max', type: 'select', options: [['', 'Celui du parcours'], ['1', '1'], ['2', '2'], ['3', '3'], ['4', '4']] },
    { key: 'priority', label: 'Priorité', type: 'number', hint: 'La plus haute l\'emporte' },
    { key: 'active', label: 'Active', type: 'checkbox' },
  ];
  const courseName = (id: string | null) => cfg.courses.find((c: any) => c.id === id)?.name ?? 'Tous';
  return (
    <div className="stack">
      <Editable title="Parcours" entity="courses" save={save} items={cfg.courses} fields={courseFields}
        newValues={{ allowedHoles: [9, 18], defaultIntervalMinutes: 6, defaultMaxPlayers: 4, playMinutes9: 135, playMinutes18: 270, active: true }}
        columns={['Nom', 'Formules', 'Intervalle', 'Max', 'Durées 9 / 18']}
        render={(c) => [<strong>{c.name}</strong>, c.allowedHoles.join(' / ') + ' trous', `${c.defaultIntervalMinutes} min`, `${c.defaultMaxPlayers} j`, `${c.playMinutes9} / ${c.playMinutes18} min`]} />
      <Editable title="Horaires, exceptions et fermetures" entity="schedule-rules" save={save} items={cfg.scheduleRules} fields={ruleFields}
        newValues={{ kind: 'open', startTime: '07:00', endTime: '17:00', priority: 0, active: true, courseId: null }}
        columns={['Règle', 'Plage', 'Période', 'Jours', 'Intervalle', 'Prio.']}
        render={(r) => [
          <><strong>{r.name}</strong> {r.kind === 'closed' ? <span className="badge warn">Fermé</span> : <span className="badge ok">Ouvert</span>}
            <div className="small muted">{courseName(r.courseId)}</div></>,
          `${r.startTime} – ${r.endTime}`,
          r.validFrom || r.validTo ? `${r.validFrom ?? '…'} → ${r.validTo ?? '…'}` : 'toujours',
          weekdaysLabel(r.weekdays),
          r.kind === 'open' ? `${r.intervalMinutes ?? 'défaut'}${r.intervalMinutes ? ' min' : ''}${r.maxPlayers ? ` · ${r.maxPlayers} j` : ''}` : '—',
          r.priority,
        ]} />
      <GridPreview cfg={cfg} base={base} />
    </div>
  );
}

function GridPreview({ cfg, base }: { cfg: any; base: string }) {
  const [courseId, setCourseId] = useState(cfg.courses[0]?.id ?? '');
  const [date, setDate] = useState(addDays(todayIn(cfg.club.timezone), 1));
  const [slots, setSlots] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!courseId || !date) return;
    get(`${base}/grid-preview?courseId=${courseId}&date=${date}`).then((r) => { setSlots(r.slots); setError(null); }).catch((e) => setError(e.message));
  }, [courseId, date, cfg]);
  return (
    <div className="card stack">
      <h2>Aperçu de la grille</h2>
      <div className="row">
        <label>Parcours<select value={courseId} onChange={(e) => setCourseId(e.target.value)}>
          {cfg.courses.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        {slots && <span className="small muted">{slots.length} départs{slots.length > 0 && ` · de ${slots[0].localTime} à ${slots.at(-1).localTime}`}</span>}
      </div>
      <ErrorBox error={error} />
      {slots && slots.length === 0 && <p className="muted">Parcours fermé ce jour-là.</p>}
      <div className="small" style={{ lineHeight: 2 }}>
        {slots?.map((s) => <span key={s.localTime} className="chip" title={`${s.maxPlayers} joueurs max · ${s.allowedHoles.join('/')} trous`}>{s.localTime}{s.maxPlayers < 4 && ` (${s.maxPlayers})`}</span>)}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Tariffs({ cfg, save }: { cfg: any; save: Save }) {
  const cur = cfg.club.currency;
  const fields: Field[] = [
    { key: 'name', label: 'Nom', type: 'text', nullable: false },
    { key: 'product', label: 'Produit', type: 'select', options: [['green_fee', 'Green fee'], ['private_surcharge', 'Supplément départ privé']] },
    { key: 'amountMinor', label: `Montant (${cur})`, type: 'money' },
    { key: 'basis', label: 'Base', type: 'select', options: [['per_player', 'Par joueur'], ['per_booking', 'Par réservation']] },
    { key: 'holes', label: 'Formule', type: 'select', options: [['', '9 et 18 trous'], ['9', '9 trous'], ['18', '18 trous']] },
    { key: 'customerCategory', label: 'Catégorie de client', type: 'text', hint: 'Vide = tous (ex. resident, membre)' },
    { key: 'courseId', label: 'Parcours', type: 'select', options: courseOptions(cfg) },
    { key: 'weekdays', label: 'Jours', type: 'weekdays', hint: 'Aucun coché = tous les jours' },
    { key: 'startTime', label: 'Départ à partir de', type: 'time' },
    { key: 'endTime', label: 'Départ avant', type: 'time' },
    { key: 'validFrom', label: 'Du (date)', type: 'date' },
    { key: 'validTo', label: 'Au (date)', type: 'date' },
    { key: 'priority', label: 'Priorité', type: 'number', hint: 'Le tarif le plus prioritaire s\'applique' },
    { key: 'active', label: 'Actif', type: 'checkbox' },
  ];
  return (
    <div className="stack">
      <Editable title="Grille tarifaire" entity="tariffs" save={save} items={cfg.tariffs} fields={fields}
        newValues={{ product: 'green_fee', basis: 'per_player', holes: 18, priority: 0, active: true, courseId: null }}
        columns={['Tarif', 'Montant', 'Formule', 'Conditions', 'Prio.']}
        render={(t) => [
          <><strong>{t.name}</strong>{t.product === 'private_surcharge' && <span className="badge private"> Privé</span>}</>,
          <>{money(t.amountMinor, cur)} <span className="small muted">{t.basis === 'per_player' ? '/ joueur' : '/ réservation'}</span></>,
          t.holes ? `${t.holes} trous` : '9 et 18',
          <span className="small">{[t.customerCategory && `catégorie ${t.customerCategory}`, weekdaysLabel(t.weekdays),
            t.startTime && `${t.startTime}–${t.endTime}`, (t.validFrom || t.validTo) && `${t.validFrom ?? '…'} → ${t.validTo ?? '…'}`].filter(Boolean).join(' · ')}</span>,
          t.priority,
        ]} />
      <p className="small muted">Pour un départ donné, le tarif actif applicable le plus prioritaire s'applique, puis le plus précis (catégorie, parcours, date, horaire, jours). Les réservations existantes gardent leur prix jusqu'à leur prochaine modification.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Resources({ cfg, base, save, reload }: { cfg: any; base: string; save: Save; reload: () => void }) {
  const cur = cfg.club.currency;
  const rtFields: Field[] = [
    { key: 'code', label: 'Code', type: 'text', createOnly: true, nullable: false, hint: 'Ex. CART, BAG_KIDS' },
    { key: 'kind', label: 'Type', type: 'select', createOnly: true, options: [['cart', 'Voiturette'], ['trolley', 'Chariot'], ['rental_bag', 'Sac de location'], ['other', 'Autre']] },
    { key: 'variant', label: 'Variante', type: 'text', createOnly: true, hint: 'Ex. men_right, women_left' },
    { key: 'name', label: 'Nom affiché', type: 'text', nullable: false },
    { key: 'totalQuantity', label: 'Quantité', type: 'number' },
    { key: 'price18Minor', label: `Prix 18 trous (${cur})`, type: 'money' },
    { key: 'price9Minor', label: `Prix 9 trous (${cur})`, type: 'money' },
    { key: 'bufferMinutes', label: 'Remise en état après usage (min)', type: 'number' },
    { key: 'maxPerBooking', label: 'Maximum par réservation', type: 'number', hint: 'Vide = pas de limite' },
    { key: 'sortOrder', label: 'Ordre d\'affichage', type: 'number' },
    { key: 'active', label: 'Proposé', type: 'checkbox' },
  ];
  const caddieFields: Field[] = [
    { key: 'displayName', label: 'Nom', type: 'text', nullable: false },
    { key: 'phone', label: 'Téléphone', type: 'text' },
    { key: 'active', label: 'Actif', type: 'checkbox' },
  ];
  const caddieType = cfg.resourceTypes.find((r: any) => r.kind === 'caddie');
  return (
    <div className="stack">
      <Editable title="Caddies (capacité, prix) et matériel de location" entity="resource-types" save={save} items={cfg.resourceTypes} fields={rtFields}
        newValues={{ kind: 'cart', totalQuantity: 1, price9Minor: 0, price18Minor: 0, bufferMinutes: 0, sortOrder: 50, active: true }}
        columns={['Ressource', 'Quantité', 'Prix 18 / 9 trous', 'Remise en état', 'Max / résa']}
        render={(r) => [
          <><strong>{r.name}</strong>{r.kind === 'caddie' && <span className="badge ok"> 1 par départ</span>}</>,
          r.totalQuantity,
          <>{money(r.price18Minor, cur)} / {money(r.price9Minor, cur)} <span className="small muted">{r.kind === 'caddie' ? 'par départ' : 'l\'unité'}</span></>,
          `${r.bufferMinutes} min`,
          r.maxPerBooking ?? '—',
        ]} />
      <Overrides cfg={cfg} base={base} reload={reload} />
      <Editable title={`Caddies nommés (${cfg.caddies.filter((c: any) => c.active).length} actifs · capacité ${caddieType?.totalQuantity ?? 0})`}
        entity="caddies" save={save} items={cfg.caddies} fields={caddieFields} newValues={{ active: true }}
        columns={['Nom', 'Téléphone', 'Statut']}
        render={(c) => [<strong>{c.displayName}</strong>, c.phone ?? '—', c.active ? 'actif' : 'inactif']} />
      <Units cfg={cfg} save={save} />
    </div>
  );
}

function Overrides({ cfg, base, reload }: { cfg: any; base: string; reload: () => void }) {
  const [rt, setRt] = useState(cfg.resourceTypes[0]?.id ?? '');
  const [date, setDate] = useState(addDays(todayIn(cfg.club.timezone), 1));
  const [qty, setQty] = useState('0');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const name = (id: string) => cfg.resourceTypes.find((r: any) => r.id === id)?.name;
  async function apply(resourceTypeId: string, d: string, quantity: number | null, why: string | null) {
    setError(null);
    try { await put(`${base}/resource-types/${resourceTypeId}/overrides/${d}`, { quantity, reason: why }); reload(); }
    catch (e) { setError((e as Error).message); }
  }
  return (
    <div className="card stack">
      <h2>Exceptions de stock par jour</h2>
      <p className="small muted">Ex. seulement 8 caddies disponibles samedi, ou 3 voiturettes en révision.</p>
      <div className="row">
        <label>Ressource<select value={rt} onChange={(e) => setRt(e.target.value)}>
          {cfg.resourceTypes.map((r: any) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
        <label>Date<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label>Quantité ce jour<input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="numeric" style={{ width: 90 }} /></label>
        <label>Motif<input value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <button className="btn primary" onClick={() => apply(rt, date, Number(qty), reason || null)}>Appliquer</button>
      </div>
      <ErrorBox error={error} />
      {cfg.capacityOverrides.map((o: any) => (
        <div key={o.resourceTypeId + o.date} className="row small" style={{ alignItems: 'center' }}>
          <span><strong>{o.date}</strong> · {name(o.resourceTypeId)} : {o.quantity}{o.reason && ` — ${o.reason}`}</span>
          <button className="btn sm" onClick={() => apply(o.resourceTypeId, o.date, null, null)}>Retirer</button>
        </div>
      ))}
    </div>
  );
}

function Units({ cfg, save }: { cfg: any; save: Save }) {
  const types = cfg.resourceTypes.filter((r: any) => r.kind !== 'caddie');
  const fields: Field[] = [
    { key: 'resourceTypeId', label: 'Type', type: 'select', createOnly: true, options: types.map((t: any) => [t.id, t.name]) },
    { key: 'label', label: 'Numéro / étiquette', type: 'text', nullable: false },
    { key: 'status', label: 'État', type: 'select', options: [['available', 'Disponible'], ['maintenance', 'En maintenance'], ['retired', 'Retiré']] },
  ];
  const typeName = (id: string) => types.find((t: any) => t.id === id)?.name;
  return (
    <Editable title="Matériel numéroté (attribué par le starter)" entity="resource-units" save={save} items={cfg.units} fields={fields}
      newValues={{ resourceTypeId: types[0]?.id, status: 'available' }}
      columns={['N°', 'Type', 'État']}
      render={(u) => [<strong>{u.label}</strong>, typeName(u.resourceTypeId),
        u.status === 'available' ? 'disponible' : u.status === 'maintenance' ? <span className="badge warn">maintenance</span> : 'retiré']} />
  );
}
