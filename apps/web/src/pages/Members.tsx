// Membres (abonnés) d'un golf : liste, adhésion, renouvellement, suspension.
// Les formules (tarif, réservation anticipée) se règlent dans Configuration → Membres.

import { useEffect, useState } from 'react';
import { get, patch, post, type User } from '../api';
import { addDays, todayIn } from '../format';
import { ErrorBox, useClubs } from './common';

export function Members({ user }: { user: User }) {
  const clubs = useClubs(user, ['org_admin', 'club_admin', 'receptionist']);
  const [clubId, setClubId] = useState<string | null>(null);
  const club = clubs.find((c) => c.id === clubId);
  const [plans, setPlans] = useState<any[]>([]);
  const [members, setMembers] = useState<any[]>([]);
  const [q, setQ] = useState('');
  const [form, setForm] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!clubId && clubs[0]) setClubId(clubs[0].id); }, [clubs]);
  const load = () => { if (clubId) get(`/api/clubs/${clubId}/members${q ? `?q=${encodeURIComponent(q)}` : ''}`).then((r) => setMembers(r.members)).catch((e) => setError(e.message)); };
  useEffect(() => { load(); }, [clubId, q]);
  useEffect(() => { if (clubId) get(`/api/clubs/${clubId}/membership-plans`).then((r) => setPlans(r.plans)).catch(() => setPlans([])); }, [clubId]);
  if (!club) return null;
  const today = todayIn(club.timezone);

  async function save() {
    setError(null);
    try {
      const h = String(form.handicap ?? '').trim().replace(',', '.');
      const common = { planId: form.planId, cardNumber: form.cardNumber || null, validFrom: form.validFrom, validTo: form.validTo,
        notes: form.notes || null, handicapIndex: h === '' ? null : Number(h) };
      if (form.id) await patch(`/api/clubs/${club!.id}/members/${form.id}`, common);
      else await post(`/api/clubs/${club!.id}/members`, { ...common, customer: { firstName: form.firstName || null, lastName: form.lastName, email: form.email || null, phone: form.phone || null } });
      setForm(null);
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className="stack">
      <div className="card row">
        <h2 style={{ margin: 0 }}>Membres</h2>
        {clubs.length > 1 && <select value={clubId ?? ''} onChange={(e) => setClubId(e.target.value)}>{clubs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
        <input placeholder="Rechercher (nom, carte, téléphone…)" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
        <button className="btn sm" disabled={!plans.length} title={plans.length ? '' : 'Créer d’abord une formule (Configuration → Membres)'}
          onClick={() => setForm({ planId: plans[0]?.id, validFrom: today, validTo: addDays(today, 364), firstName: '', lastName: '' })}>+ Nouveau membre</button>
      </div>
      {!plans.length && <div className="alert">Aucune formule d'abonnement : la direction la crée dans Configuration → Membres (tarif membre, réservation anticipée).</div>}
      <ErrorBox error={error} />
      {form && (
        <div className="card stack">
          <h3 style={{ margin: 0 }}>{form.id ? `${form.firstName ?? ''} ${form.lastName}` : 'Nouveau membre'}</h3>
          {!form.id && <div className="grid2">
            <label>Prénom<input value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} /></label>
            <label>Nom<input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} /></label>
            <label>E-mail<input value={form.email ?? ''} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
            <label>Téléphone<input value={form.phone ?? ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></label>
          </div>}
          <div className="grid2">
            <label>Formule<select value={form.planId} onChange={(e) => setForm({ ...form, planId: e.target.value })}>
              {plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label>N° de carte<input value={form.cardNumber ?? ''} onChange={(e) => setForm({ ...form, cardNumber: e.target.value })} /></label>
            <label>Valable du<input type="date" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} /></label>
            <label>au<input type="date" value={form.validTo} onChange={(e) => setForm({ ...form, validTo: e.target.value })} /></label>
            <label>Index (handicap)<input value={form.handicap ?? ''} inputMode="decimal" onChange={(e) => setForm({ ...form, handicap: e.target.value })} /></label>
            <label>Notes<input value={form.notes ?? ''} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
          </div>
          <p className="small muted" style={{ margin: 0 }}>Pour qu'il réserve lui-même (application golfeur), le membre crée son compte avec la même adresse e-mail… ou la réception le rattache lors d'une réservation.</p>
          <div className="row">
            <button className="btn primary" disabled={!form.lastName?.trim() || !form.planId} onClick={save}>Enregistrer</button>
            <button className="btn" onClick={() => setForm(null)}>Annuler</button>
          </div>
        </div>
      )}
      <div className="card table-wrap">
        <table className="sheet">
          <thead><tr><th>Membre</th><th>Index</th><th>Formule</th><th>Carte</th><th>Validité</th><th>Parties</th><th>État</th><th /></tr></thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id}>
                <td><strong>{[m.firstName, m.lastName].filter(Boolean).join(' ')}</strong><div className="small muted">{[m.phone, m.email].filter(Boolean).join(' · ')}</div></td>
                <td>{m.handicapIndex ?? '—'}</td><td>{m.planName}</td><td>{m.cardNumber ?? ''}</td>
                <td className="small">{m.validFrom} → {m.validTo}</td><td>{m.roundsThisPeriod}</td>
                <td>{m.status === 'suspended' ? <span className="badge warn">suspendu</span> : m.current ? <span className="badge ok">actif</span> : <span className="badge">échu</span>}</td>
                <td className="row">
                  <button className="btn sm" onClick={() => setForm({ ...m, handicap: m.handicapIndex ?? '' })}>Modifier</button>
                  {!m.current && m.status === 'active' && <button className="btn sm" onClick={() => setForm({ ...m, handicap: m.handicapIndex ?? '',
                    validFrom: m.validTo < today ? today : addDays(m.validTo, 1), validTo: addDays(m.validTo < today ? today : addDays(m.validTo, 1), 364) })}>Renouveler</button>}
                  <button className="btn sm" onClick={() => patch(`/api/clubs/${club.id}/members/${m.id}`, { status: m.status === 'active' ? 'suspended' : 'active' }).then(load)
                    .catch((e) => setError(e.message))}>{m.status === 'active' ? 'Suspendre' : 'Réactiver'}</button>
                </td>
              </tr>
            ))}
            {members.length === 0 && <tr><td colSpan={8} className="muted">Aucun membre.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
