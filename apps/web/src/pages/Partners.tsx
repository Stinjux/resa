// Configuration → Partenaires : tour-opérateurs, agences, hôtels, entreprises ;
// accès au portail, allotements du golf, relevé de compte.

import { useEffect, useState } from 'react';
import { download, get, patch, post } from '../api';
import { money, todayIn } from '../format';
import { ErrorBox } from './common';
import { DocOverlay } from './Documents';
import { EntityForm, weekdaysLabel, type Field } from './EntityForm';

const KIND: Record<string, string> = {
  tour_operator: 'Tour-opérateur', travel_agency: 'Agence de voyage', hotel: 'Hôtel', corporate: 'Entreprise', other: 'Autre',
};

export function PartnersTab({ cfg, clubId, categories }: { cfg: any; clubId: string; categories: string[] }) {
  const [partners, setPartners] = useState<any[]>([]);
  const [editing, setEditing] = useState<any | null>(null);
  const [access, setAccess] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => get('/api/partners').then((r) => setPartners(r.partners)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const fields: Field[] = [
    { key: 'code', label: 'Code', type: 'text', nullable: false },
    { key: 'name', label: 'Nom', type: 'text', nullable: false },
    { key: 'kind', label: 'Type', type: 'select', options: Object.entries(KIND) },
    { key: 'priceCategory', label: 'Catégorie tarifaire (tarifs négociés)', type: 'select',
      options: [...new Set(['standard', ...categories, editing?.priceCategory].filter(Boolean))].map((c) => [c, c] as [string, string]),
      hint: 'Créer les tarifs de cette catégorie dans l’onglet Tarifs (ex. « to »)' },
    { key: 'onAccount', label: 'Règlement sur relevé (pas au comptoir)', type: 'checkbox' },
    { key: 'paymentTermsDays', label: 'Délai de paiement (jours)', type: 'number' },
    { key: 'contactName', label: 'Contact', type: 'text' },
    { key: 'email', label: 'E-mail', type: 'text' },
    { key: 'phone', label: 'Téléphone', type: 'text' },
    { key: 'legalName', label: 'Raison sociale (factures)', type: 'text' },
    { key: 'address', label: 'Adresse (factures)', type: 'text' },
    { key: 'ice', label: 'ICE', type: 'text' },
    { key: 'notes', label: 'Notes (conditions négociées…)', type: 'text' },
    { key: 'active', label: 'Actif', type: 'checkbox' },
  ];

  return (
    <div className="stack">
      <div className="card stack">
        <div className="row">
          <h2 style={{ margin: 0 }}>Partenaires</h2>
          <span className="spacer" />
          <button className="btn sm" onClick={() => setEditing({ kind: 'tour_operator', priceCategory: 'standard', onAccount: true, paymentTermsDays: 30, active: true })}>+ Ajouter</button>
        </div>
        <p className="small muted" style={{ margin: 0 }}>
          Communs à tous les golfs. Leurs réservations sont toujours tarifées avec leur catégorie (grille Tarifs),
          et peuvent occuper les départs de leurs allotements.
        </p>
        {editing && (
          <EntityForm key={editing.id ?? 'new'} fields={fields} isNew={!editing.id} initial={editing} onCancel={() => setEditing(null)}
            onSubmit={async (v) => {
              if (editing.id) await patch(`/api/partners/${editing.id}`, v); else await post('/api/partners', v);
              setEditing(null);
              load();
            }} />
        )}
        <div className="table-wrap"><table className="sheet">
          <thead><tr><th>Partenaire</th><th>Type</th><th>Tarif</th><th>Règlement</th><th>Contact</th><th>Portail</th><th /></tr></thead>
          <tbody>
            {partners.map((p) => (
              <tr key={p.id} className={p.active ? '' : 'muted'}>
                <td><strong>{p.name}</strong> <span className="small muted">{p.code}</span>{!p.active && <span className="badge"> inactif</span>}</td>
                <td>{KIND[p.kind]}</td><td>{p.priceCategory}</td>
                <td className="small">{p.onAccount ? `sur relevé, ${p.paymentTermsDays} j` : 'au comptoir'}</td>
                <td className="small">{[p.contactName, p.email, p.phone].filter(Boolean).join(' · ')}</td>
                <td className="small">{p.portalUsers} accès</td>
                <td className="row">
                  <button className="btn sm" onClick={() => setEditing(p)}>Modifier</button>
                  <button className="btn sm" onClick={() => { setAccess(p.id); setMessage(null); }}>Créer un accès</button>
                </td>
              </tr>
            ))}
            {partners.length === 0 && <tr><td colSpan={7} className="muted">Aucun partenaire.</td></tr>}
          </tbody>
        </table></div>
        {access && (
          <EntityForm key={access} isNew submitLabel="Créer l'accès au portail" onCancel={() => setAccess(null)}
            fields={[{ key: 'displayName', label: 'Nom de l’utilisateur', type: 'text', nullable: false },
              { key: 'email', label: 'E-mail de connexion', type: 'text', nullable: false },
              { key: 'password', label: 'Mot de passe provisoire (8 caractères min.)', type: 'text', nullable: false }]}
            initial={{}} onSubmit={async (v) => {
              await post(`/api/partners/${access}/users`, v);
              setMessage(`Accès créé pour ${v.email}. Le partenaire se connecte sur la page de connexion de Resa.`);
              setAccess(null);
              load();
            }} />
        )}
        {message && <div className="alert ok">{message}</div>}
        <ErrorBox error={error} />
      </div>
      <Allotments cfg={cfg} clubId={clubId} partners={partners.filter((p) => p.active)} />
      <Statement clubId={clubId} timezone={cfg.club.timezone} partners={partners} />
    </div>
  );
}

function Allotments({ cfg, clubId, partners }: { cfg: any; clubId: string; partners: any[] }) {
  const [list, setList] = useState<any[]>([]);
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => get(`/api/clubs/${clubId}/allotments`).then((r) => setList(r.allotments)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [clubId]);
  const today = todayIn(cfg.club.timezone);
  const fields: Field[] = [
    { key: 'partnerId', label: 'Partenaire', type: 'select', options: partners.map((p) => [p.id, p.name] as [string, string]) },
    { key: 'courseId', label: 'Parcours', type: 'select', options: cfg.courses.map((c: any) => [c.id, c.name] as [string, string]) },
    { key: 'dateFrom', label: 'Du', type: 'date', nullable: false },
    { key: 'dateTo', label: 'Au', type: 'date', nullable: false },
    { key: 'weekdays', label: 'Jours', type: 'weekdays' },
    { key: 'startTime', label: 'De (premier départ)', type: 'time', nullable: false },
    { key: 'endTime', label: 'À (dernier départ, inclus)', type: 'time', nullable: false },
    { key: 'releaseDays', label: 'Release (jours avant la date)', type: 'number', hint: 'Les départs non utilisés reviennent alors à la vente' },
    { key: 'note', label: 'Note', type: 'text' },
  ];
  return (
    <div className="card stack">
      <div className="row">
        <h2 style={{ margin: 0 }}>Allotements de ce golf</h2>
        <span className="spacer" />
        {partners.length > 0 && <button className="btn sm" onClick={() => setAdding(true)}>+ Ajouter</button>}
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Les départs libres de la plage sont retirés de la vente et réservés au partenaire jusqu'à la date de release.
        Les départs déjà réservés ou bloqués ne sont pas pris.
      </p>
      {adding && (
        <EntityForm isNew fields={fields} onCancel={() => setAdding(false)} submitLabel="Créer l'allotement"
          initial={{ partnerId: partners[0]?.id, courseId: cfg.courses[0]?.id, dateFrom: today, dateTo: today, weekdays: [1, 2, 3, 4, 5, 6, 7],
            startTime: '08:00', endTime: '09:00', releaseDays: 7 }}
          onSubmit={async (v) => {
            const r = await post(`/api/clubs/${clubId}/allotments`, v);
            setMessage(`${r.held} départ(s) tenu(s) pour le partenaire.`);
            setAdding(false);
            load();
          }} />
      )}
      {message && <div className="alert ok">{message}</div>}
      <ErrorBox error={error} />
      <div className="table-wrap"><table className="sheet">
        <thead><tr><th>Partenaire</th><th>Parcours</th><th>Période</th><th>Plage</th><th>Release</th><th>Départs tenus</th><th>Joueurs réservés</th><th /></tr></thead>
        <tbody>
          {list.map((a) => (
            <tr key={a.id} className={a.status === 'cancelled' ? 'muted' : ''}>
              <td>{a.partnerName}{a.status === 'cancelled' && <span className="badge"> annulé</span>}</td><td>{a.courseName}</td>
              <td className="small">{a.dateFrom} → {a.dateTo}<div className="muted">{weekdaysLabel(a.weekdays)}</div></td>
              <td>{a.startTime}–{a.endTime}</td><td>J-{a.releaseDays}</td><td>{a.heldTeeTimes}</td><td>{a.bookedPlayers}</td>
              <td>{a.status === 'active' && <button className="btn sm" onClick={() => {
                if (!window.confirm('Annuler cet allotement ? Les départs non réservés reviennent à la vente.')) return;
                post(`/api/clubs/${clubId}/allotments/${a.id}/cancel`).then((r) => { setMessage(`${r.released} départ(s) rendu(s) à la vente.`); load(); })
                  .catch((e) => setError(e.message));
              }}>Annuler</button>}</td>
            </tr>
          ))}
          {list.length === 0 && <tr><td colSpan={8} className="muted">Aucun allotement.</td></tr>}
        </tbody>
      </table></div>
    </div>
  );
}

function Statement({ clubId, timezone, partners }: { clubId: string; timezone: string; partners: any[] }) {
  const today = todayIn(timezone);
  const [partnerId, setPartnerId] = useState('');
  const [from, setFrom] = useState(`${today.slice(0, 8)}01`);
  const [to, setTo] = useState(today);
  const [data, setData] = useState<any>(null);
  const [print, setPrint] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!partnerId && partners[0]) setPartnerId(partners[0].id); }, [partners]);
  const q = `clubId=${clubId}&from=${from}&to=${to}`;
  useEffect(() => {
    if (!partnerId || !from || !to) return;
    setError(null);
    get(`/api/partners/${partnerId}/statement?${q}`).then((r) => setData(r.statement)).catch((e) => { setData(null); setError(e.message); });
  }, [partnerId, from, to, clubId]);
  const cur = data?.bookings[0]?.currency ?? 'MAD';
  const table = data && (
    <table className="sheet doc-table">
      <thead><tr><th>Date</th><th>Réservation</th><th>Voucher</th><th>Client</th><th>Joueurs</th><th>Statut</th><th>Montant</th><th>Réglé</th><th>Reste dû</th><th>Facture</th></tr></thead>
      <tbody>
        {data.bookings.map((b: any) => (
          <tr key={b.id}>
            <td>{new Date(b.startsAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: b.timezone })}</td>
            <td>{b.reference}</td><td>{b.partnerReference ?? ''}</td><td>{b.leadName ?? ''}</td><td>{b.players}</td>
            <td>{b.status === 'cancelled' ? 'annulée' : b.checkinStatus === 'no_show' ? 'absent' : 'confirmée'}</td>
            <td>{money(b.totalMinor, b.currency)}</td><td>{money(b.paidMinor, b.currency)}</td><td>{money(b.balanceMinor, b.currency)}</td>
            <td className="small">{b.invoiceNumbers ?? ''}</td>
          </tr>
        ))}
        {data.bookings.length === 0 && <tr><td colSpan={10} className="muted">Aucune réservation sur la période.</td></tr>}
        <tr><td colSpan={4}><strong>Total</strong></td><td><strong>{data.totals.players}</strong></td><td />
          <td><strong>{money(data.totals.totalMinor, cur)}</strong></td><td><strong>{money(data.totals.paidMinor, cur)}</strong></td>
          <td><strong>{money(data.totals.balanceMinor, cur)}</strong></td><td /></tr>
      </tbody>
    </table>
  );
  return (
    <div className="card stack">
      <div className="row">
        <h2 style={{ margin: 0 }}>Relevé de compte</h2>
        <span className="spacer" />
        <select value={partnerId} onChange={(e) => setPartnerId(e.target.value)}>
          {partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        <label className="row small">Du<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="row small">au<input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        {data && <button className="btn sm" onClick={() => setPrint(true)}>Imprimer / PDF</button>}
        {data && <button className="btn sm" onClick={() => download(`/api/partners/${partnerId}/statement.csv?${q}`, `releve-${data.partner.code}-${from}-${to}.csv`)
          .catch((e) => setError(e.message))}>Excel</button>}
      </div>
      <p className="small muted" style={{ margin: 0 }}>Réservations dont le départ est dans la période (relevé réservé à la direction).</p>
      <ErrorBox error={error} />
      <div className="table-wrap">{table}</div>
      {print && data && (
        <DocOverlay onClose={() => setPrint(false)}>
          <div className="doc">
            <div className="doc-head">
              <div><div className="doc-title">RELEVÉ DE COMPTE</div><div>Période du {from} au {to}</div></div>
              <div className="doc-buyer"><strong>{data.partner.legalName ?? data.partner.name}</strong>
                {data.partner.address && <div>{data.partner.address}</div>}{data.partner.ice && <div>ICE : {data.partner.ice}</div>}</div>
            </div>
            {table}
            {data.partner.onAccount && <p>Règlement à {data.partner.paymentTermsDays} jours.</p>}
          </div>
        </DocOverlay>
      )}
    </div>
  );
}
