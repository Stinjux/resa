import { useCallback, useEffect, useState } from 'react';
import { get, patch, post, put, type User } from '../api';
import { addDays, money, todayIn } from '../format';
import { EntityForm, weekdaysLabel, type Field } from './EntityForm';
import { ErrorBox, useClubs } from './common';
import { PartnersTab } from './Partners';

type Tab = 'general' | 'schedule' | 'tariffs' | 'resources' | 'partners' | 'emails' | 'pos';

export function Config({ user }: { user: User }) {
  const [clubsVersion, setClubsVersion] = useState(0);
  const clubs = useClubs(user, ['org_admin', 'club_admin'], clubsVersion);
  const isOrgAdmin = user.roles.some((r) => r.role === 'org_admin' && r.clubId === null);
  const [creating, setCreating] = useState(false);
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
        {isOrgAdmin && <button className="btn sm" onClick={() => setCreating(true)}>+ Nouveau golf</button>}
        <nav className="nav">
          {([['general', 'Général'], ['schedule', 'Parcours & horaires'], ['tariffs', 'Tarifs'], ['resources', 'Caddies & matériel'], ['partners', 'Partenaires'], ['emails', 'E-mails'], ['pos', 'Caisse (POS)']] as Array<[Tab, string]>)
            .map(([t, l]) => <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{l}</button>)}
        </nav>
      </div>
      <ErrorBox error={error} />
      {creating && (
        <div className="card stack">
          <h2>Nouveau golf</h2>
          <EntityForm isNew initial={{ timezone: 'Africa/Casablanca', currency: 'MAD', defaultLocale: 'fr', countryCode: 'MA', taxRate: '20' }}
            fields={[
              { key: 'code', label: 'Code court', type: 'text', nullable: false, hint: 'Ex. G5 (majuscules)' },
              { key: 'name', label: 'Nom', type: 'text', nullable: false },
              { key: 'timezone', label: 'Fuseau horaire', type: 'text', nullable: false, hint: 'Ex. Africa/Casablanca, Europe/Lisbon' },
              { key: 'currency', label: 'Devise', type: 'text', nullable: false, hint: 'MAD, EUR, USD…' },
              { key: 'defaultLocale', label: 'Langue', type: 'select', options: [['fr', 'Français'], ['en', 'English'], ['ar', 'العربية'], ['es', 'Español']] },
              { key: 'countryCode', label: 'Pays (code ISO)', type: 'text', hint: 'MA, PT, ES…' },
              { key: 'taxRate', label: 'TVA (%)', type: 'text', nullable: false },
            ]}
            onSubmit={async (v) => {
              const { taxRate, ...rest } = v;
              const r = await post<{ id: string }>('/api/clubs', { ...rest, taxRateBp: Math.round(Number(String(taxRate).replace(',', '.')) * 100) });
              setCreating(false);
              setClubsVersion((n) => n + 1);
              setClubId(r.id);
              setCfg(null);
              setTab('general');
            }}
            onCancel={() => setCreating(false)} submitLabel="Créer le golf" />
          <p className="small muted" style={{ margin: 0 }}>Un parcours et une ouverture 07:00–17:00 sont créés ; renseignez ensuite les tarifs et le nombre de caddies (aucune réservation n'est possible sans green fee).</p>
        </div>
      )}
      {cfg && tab === 'general' && <General cfg={cfg} onSave={async (v) => { await patch(base, v); load(); }} />}
      {cfg && tab === 'schedule' && <Schedule cfg={cfg} base={base} save={save} />}
      {cfg && tab === 'tariffs' && <Tariffs cfg={cfg} save={save} />}
      {cfg && tab === 'resources' && <Resources cfg={cfg} base={base} save={save} reload={load} />}
      {cfg && tab === 'partners' && <PartnersTab cfg={cfg} clubId={clubId!}
        categories={[...new Set<string>(cfg.tariffs.map((t: any) => t.customerCategory).filter(Boolean))]} />}
      {cfg && tab === 'emails' && <Emails clubId={clubId!} enabled={cfg.club.emailEnabled} />}
      {cfg && tab === 'pos' && <PosSync clubId={clubId!} posProvider={cfg.club.posProvider} />}
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
    { key: 'cancellationFreeHours', label: 'Annulation gratuite jusqu\'à (heures avant)', type: 'number' },
    { key: 'cancellationFeePercent', label: 'Frais d\'annulation tardive (%)', type: 'number' },
    { key: 'customerCanCancel', label: 'Le client peut annuler en ligne (dans le délai gratuit)', type: 'checkbox' },
    { key: 'onlinePayment', label: 'Paiement en ligne', type: 'select', options: [['none', 'Non (règlement au golf)'], ['optional', 'Proposé'], ['required', 'Obligatoire']],
      hint: 'Nécessite un prestataire de paiement (non encore branché)' },
    { key: 'messagingProvider', label: 'Messagerie WhatsApp / SMS', type: 'select', options: [['', 'Aucune'], ...(cfg.messagingProviders ?? []).map((p: string) => [p, p === 'local' ? 'local (simulateur)' : p] as [string, string])],
      hint: 'Les demandes reçues doivent être validées par la réception ou la direction' },
    { key: 'legalName', label: 'Raison sociale (factures)', type: 'text' },
    { key: 'legalAddress', label: 'Adresse du siège (factures)', type: 'text' },
    { key: 'ice', label: 'ICE', type: 'text', hint: 'Identifiant commun de l\'entreprise, obligatoire sur les factures au Maroc' },
    { key: 'taxId', label: 'Identifiant fiscal (IF)', type: 'text' },
    { key: 'tradeRegister', label: 'Registre du commerce (RC)', type: 'text' },
    { key: 'patente', label: 'Patente (taxe professionnelle)', type: 'text' },
    { key: 'invoiceFooter', label: 'Pied de facture', type: 'text', hint: 'Ex. capital social, coordonnées bancaires (RIB)' },
    { key: 'emailEnabled', label: 'E-mails aux clients (confirmation, modification, annulation, rappel)', type: 'checkbox' },
    { key: 'reminderHoursBefore', label: 'Rappel par e-mail (heures avant le départ, 0 = aucun)', type: 'number' },
    { key: 'contactPhone', label: 'Téléphone affiché aux clients', type: 'text' },
    { key: 'emailReplyTo', label: 'Adresse de réponse des e-mails', type: 'text', hint: 'Les réponses des clients arrivent à cette adresse' },
    { key: 'posProvider', label: 'Caisse (POS)', type: 'select', options: [['', 'Aucune'], ...(cfg.posProviders ?? []).map((p: string) => [p, p === 'local' ? 'local (démonstration)' : p] as [string, string])] },
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
                <td style={{ textAlign: 'end' }}><button className="btn sm" onClick={() => setEditing(item.id)}>Modifier</button></td>
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

// ---------------------------------------------------------------------------

const EMAIL_STATUS: Record<string, [string, string]> = {
  pending: ['en attente', 'badge'], sent: ['envoyé', 'badge ok'], logged: ['journalisé (non envoyé)', 'badge'], failed: ['en échec', 'badge private'],
};
const EMAIL_KIND: Record<string, string> = { confirmation: 'Confirmation', modification: 'Modification', cancellation: 'Annulation', reminder: 'Rappel' };

function Emails({ clubId, enabled }: { clubId: string; enabled: boolean }) {
  const [data, setData] = useState<any>(null);
  const [preview, setPreview] = useState<any>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => get(`/api/clubs/${clubId}/emails`).then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); setPreview(null); }, [clubId]);

  async function resend(id: string) {
    setError(null);
    try { await post(`/api/clubs/${clubId}/emails/${id}/resend`); setMessage('Renvoyé.'); load(); } catch (e) { setError((e as Error).message); }
  }

  return (
    <div className="stack">
      <div className="card stack">
        <h2>E-mails envoyés aux clients</h2>
        <p className="small muted" style={{ margin: 0 }}>
          {!enabled ? <>Les e-mails sont <strong>désactivés</strong> pour ce golf (onglet Général).</>
            : data?.mode === 'smtp' ? <>Envoi <strong>actif</strong> (SMTP). Confirmation, modification, annulation et rappel partent automatiquement vers les clients qui ont une adresse e-mail.</>
            : <><strong>Mode journal</strong> : aucun e-mail ne part réellement (serveur d'envoi non configuré, variable <code>SMTP_URL</code>). Les messages sont préparés et consultables ici.</>}
        </p>
        {message && <div className="alert ok">{message}</div>}
        <ErrorBox error={error} />
      </div>
      <div className="card table-wrap">
        <table className="sheet">
          <thead><tr><th>Date</th><th>Type</th><th>Réservation</th><th>Destinataire</th><th>État</th><th /></tr></thead>
          <tbody>
            {data?.emails.map((m: any) => (
              <tr key={m.id}>
                <td className="small">{new Date(m.createdAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</td>
                <td>{EMAIL_KIND[m.kind] ?? m.kind}</td>
                <td>{m.reference}</td>
                <td className="small">{m.to}</td>
                <td><span className={EMAIL_STATUS[m.status]?.[1]}>{EMAIL_STATUS[m.status]?.[0] ?? m.status}</span>
                  {m.lastError && <div className="small" style={{ color: 'var(--danger)' }}>{m.lastError}</div>}</td>
                <td className="row">
                  <button className="btn sm" onClick={() => get(`/api/emails/${m.id}`).then((r) => setPreview(r.email)).catch((e) => setError(e.message))}>Voir</button>
                  {m.status !== 'pending' && <button className="btn sm" onClick={() => resend(m.id)}>Renvoyer</button>}
                </td>
              </tr>
            ))}
            {data?.emails.length === 0 && <tr><td colSpan={6} className="muted">Aucun e-mail. Les clients sans adresse e-mail n'en reçoivent pas.</td></tr>}
          </tbody>
        </table>
      </div>
      {preview && (
        <div className="card stack">
          <div className="row"><strong>{preview.subject}</strong><span className="small muted">→ {preview.to}</span><span className="spacer" />
            <button className="btn sm" onClick={() => setPreview(null)}>Fermer</button></div>
          <iframe title="Aperçu" sandbox="" srcDoc={preview.html} style={{ width: '100%', height: 520, border: '1px solid var(--border)', borderRadius: 8, background: '#fff' }} />
        </div>
      )}
    </div>
  );
}

const JOB_STATUS: Record<string, [string, string]> = {
  pending: ['en attente', 'badge'], processing: ['en cours', 'badge'], succeeded: ['synchronisé', 'badge ok'],
  superseded: ['remplacé', 'badge'], failed: ['nouvel essai prévu', 'badge warn'], dead: ['en échec', 'badge private'],
};
const OPERATION: Record<string, string> = { upsert_sale: 'Vente', record_payment: 'Paiement', record_refund: 'Remboursement' };

function PosSync({ clubId, posProvider }: { clubId: string; posProvider: string | null }) {
  const [data, setData] = useState<any>(null);
  const [filter, setFilter] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => get(`/api/clubs/${clubId}/pos/jobs${filter ? `?status=${filter}` : ''}`).then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [clubId, filter]);

  async function act(fn: () => Promise<any>, ok: (r: any) => string) {
    setError(null);
    try { setMessage(ok(await fn())); load(); } catch (e) { setError((e as Error).message); }
  }

  return (
    <div className="stack">
      <div className="card stack">
        <h2>Synchronisation avec la caisse</h2>
        <p className="small muted" style={{ margin: 0 }}>
          {posProvider
            ? <>Connecteur actif : <strong>{posProvider}</strong>. Chaque vente, paiement et remboursement est mis en file puis envoyé automatiquement (toutes les 30 s), avec reprises en cas d'erreur et sans doublon.</>
            : <>Aucune caisse configurée (onglet Général). Les commandes sont gérées dans Resa ; rien n'est envoyé.</>}
        </p>
        {data && (
          <div className="row small">
            {Object.entries(JOB_STATUS).map(([k, [label, cls]]) => (
              <button key={k} className={`btn sm ${filter === k ? 'primary' : ''}`} onClick={() => setFilter(filter === k ? '' : k)}>
                <span className={cls}>{label}</span> {data.counts[k] ?? 0}
              </button>
            ))}
            <span className="spacer" />
            <button className="btn sm" onClick={() => act(() => post(`/api/clubs/${clubId}/pos/process`),
              (r) => `${r.processed} traité(s) : ${r.succeeded} synchronisé(s), ${r.failed} à réessayer, ${r.dead} en échec.`)}>Synchroniser maintenant</button>
          </div>
        )}
        {message && <div className="alert ok">{message}</div>}
        <ErrorBox error={error} />
      </div>
      <div className="card table-wrap">
        <table className="sheet">
          <thead><tr><th>Date</th><th>Opération</th><th>Réservation</th><th>État</th><th>Essais</th><th>Détail</th><th /></tr></thead>
          <tbody>
            {data?.jobs.map((j: any) => (
              <tr key={j.id}>
                <td className="small">{new Date(j.createdAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</td>
                <td>{OPERATION[j.operation]}{j.operation === 'upsert_sale' && <span className="small muted"> v{j.entityVersion}</span>}</td>
                <td>{j.reference}</td>
                <td><span className={JOB_STATUS[j.status]?.[1]}>{JOB_STATUS[j.status]?.[0] ?? j.status}</span></td>
                <td>{j.attempts}/{j.maxAttempts}</td>
                <td className="small">{j.lastError ? <span style={{ color: 'var(--danger)' }}>{j.lastError}</span> : j.externalId ?? ''}</td>
                <td>{['failed', 'dead'].includes(j.status) && (
                  <button className="btn sm" onClick={() => act(() => post(`/api/clubs/${clubId}/pos/jobs/${j.id}/retry`), () => 'Relancé.')}>Relancer</button>
                )}</td>
              </tr>
            ))}
            {data?.jobs.length === 0 && <tr><td colSpan={7} className="muted">Aucune opération.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
