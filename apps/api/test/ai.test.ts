import { describe, expect, it } from 'vitest';
import type { AiModel, AiRequest } from '../src/modules/ai/model.js';
import { cancelDraft, confirmDraft, getConversation, runAssistantTurn } from '../src/modules/ai/assistant.js';
import { computeReportData, generateReport } from '../src/modules/ai/reports.js';
import { createStaffUser, loadPrincipal } from '../src/modules/auth/service.js';
import type { Role } from '../src/modules/auth/permissions.js';
import { createBooking } from '../src/modules/booking/service.js';
import { recordStaffPayment } from '../src/modules/orders/service.js';
import { buildServer } from '../src/http/server.js';
import { DAY, NOW, at, createClub, deps, staff, useTestDb, type Fixture } from './helpers.js';

const db = useTestDb();

// ---------------------------------------------------------------------------
// Faux modèle : chaque étape reçoit la requête et renvoie une réponse.

type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown };
type Step = (req: AiRequest) => { content: Block[]; stop_reason?: string };

class ScriptedModel implements AiModel {
  readonly name = 'modele-de-test';
  requests: AiRequest[] = [];
  constructor(private steps: Step[]) {}
  async create(req: AiRequest) {
    this.requests.push(structuredClone(req));
    const step = this.steps.shift();
    if (!step) throw new Error('Script épuisé');
    const r = step(req);
    const stop = r.stop_reason ?? (r.content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
    return { id: 'msg', type: 'message', role: 'assistant', model: this.name, content: r.content, stop_reason: stop,
      stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } as never;
  }
}

const say = (text: string): Step => () => ({ content: [{ type: 'text', text }] });
const call = (name: string, input: unknown | ((req: AiRequest) => unknown)): Step => (req) => ({
  content: [{ type: 'tool_use', id: `tu_${name}_${Math.random().toString(36).slice(2, 7)}`, name,
    input: typeof input === 'function' ? (input as (r: AiRequest) => unknown)(req) : input }],
});
/** Dernier résultat d'outil envoyé au modèle. */
function lastResult(req: AiRequest): { content: string; is_error?: boolean } {
  const last = req.messages.at(-1)!;
  const block = (last.content as Array<{ type: string; content?: string; is_error?: boolean }>).find((b) => b.type === 'tool_result')!;
  return { content: block.content!, is_error: block.is_error };
}

let n = 0;
async function principal(f: Fixture, role: Role) {
  const id = await createStaffUser(db, { organizationId: f.organizationId, email: `ai.${role}.${++n}.${Date.now()}@test.ma`,
    password: 'motdepasse-test', displayName: `Test ${role}`, roles: [{ clubId: f.clubId, role }] });
  return (await loadPrincipal(db, id))!;
}

describe('assistant de réservation', () => {
  it('« book moi 2 départs à 13h » : demande les infos manquantes, prépare un brouillon, ne réserve qu’à la confirmation', async () => {
    const f = await createClub(db);
    const p = await principal(f, 'receptionist');
    const model = new ScriptedModel([
      // Tour 1 : il manque joueurs, formule, client.
      say('Combien de joueurs par départ, 9 ou 18 trous, et pour quel client (nom et téléphone) ?'),
      // Tour 2 : vérifications puis brouillon.
      call('list_golfs', {}),
      call('find_available_tee_times', { course_id: f.courseId, date: DAY, players: 4, holes: 18, from_time: '13h', to_time: '13:30' }),
      call('search_golfers', { club_id: f.clubId, query: 'Alami' }),
      call('propose_booking', (req: AiRequest) => {
        const slots = JSON.parse(lastResult(req).content); // résultat de search_golfers (vide)
        expect(slots).toEqual([]);
        return { tee_times: ['13:00', '13:06'].map((time) => ({ course_id: f.courseId, date: DAY, time, players: 4, holes: 18 })),
          new_customer: { first_name: 'Youssef', last_name: 'Alami', phone: '+212612345678' } };
      }),
      say('Voici le récapitulatif : 2 départs à 13:00 et 13:06. Vérifiez puis confirmez.'),
    ]);
    const d = { ...deps(db), model };

    const t1 = await runAssistantTurn(d, p, { message: 'book moi 2 départs à 13h le 10 juin 2030' });
    expect(t1.reply).toContain('Combien de joueurs');
    expect(t1.drafts).toEqual([]);
    // Le contexte (date du jour dans le golf) est fourni au premier message.
    const firstUser = model.requests[0]!.messages[0]!.content as Array<{ text: string }>;
    expect(firstUser[0]!.text).toContain('[Contexte fourni par Resa]');
    expect(firstUser[0]!.text).toContain('2030-06-01');

    const t2 = await runAssistantTurn(d, p, { conversationId: t1.conversationId, message: '4 joueurs chacun, 18 trous, Youssef Alami 0612345678' });
    expect(t2.conversationId).toBe(t1.conversationId);
    expect(t2.drafts).toHaveLength(1);
    const draft = t2.drafts[0]!;
    expect(draft.status).toBe('pending');
    expect((draft.summary as { teeTimes: unknown[] }).teeTimes).toHaveLength(2);
    expect((draft.summary as { totalMinor: number }).totalMinor).toBe(2 * (4 * 130000 + 20000));
    // L'historique complet est renvoyé au modèle à chaque appel.
    expect(model.requests.at(-1)!.messages.length).toBeGreaterThan(6);

    // Rien n'est réservé avant la confirmation humaine.
    const before = await db.query('SELECT count(*)::int AS n FROM bookings WHERE club_id = $1', [f.clubId]);
    expect(before.rows[0].n).toBe(0);

    const confirmed = await confirmDraft(deps(db), p, draft.id);
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.bookingReferences).toHaveLength(2);
    const again = await confirmDraft(deps(db), p, draft.id); // double clic
    expect(again.bookingReferences).toEqual(confirmed.bookingReferences);
    const after = await db.query('SELECT count(*)::int AS n, sum(players)::int AS players FROM bookings WHERE club_id = $1', [f.clubId]);
    expect(after.rows[0]).toEqual({ n: 2, players: 8 });

    const conv = await getConversation(db, p, t1.conversationId);
    expect(conv.transcript.at(-1)!.text).toContain('[Système]');
    expect(conv.transcript.some((m) => m.text.includes('[Contexte'))).toBe(false);
  });

  it('refuse un créneau indisponible et laisse l’IA proposer autre chose', async () => {
    const f = await createClub(db, { caddies: 1 });
    await createBooking(deps(db), staff, { courseId: f.courseId, startsAt: at('13:00'), players: 4, holes: 18 });
    const p = await principal(f, 'receptionist');
    let error: { content: string; is_error?: boolean } | null = null;
    const model = new ScriptedModel([
      call('propose_booking', { tee_times: [{ course_id: f.courseId, date: DAY, time: '13:06', players: 2, holes: 18 }],
        new_customer: { last_name: 'Bennani', phone: '0600000000' } }),
      (req) => { error = lastResult(req); return { content: [{ type: 'text', text: 'Ce départ n’est pas libre, voulez-vous 17:30 ?' }] }; },
    ]);
    const t = await runAssistantTurn({ ...deps(db), model }, p, { message: 'Bennani 2 joueurs 13h06' });
    expect(error!.is_error).toBe(true);
    expect(error!.content).toContain('SLOT_NOT_AVAILABLE'); // le seul caddie est pris
    expect(t.drafts).toEqual([]);
  });

  it('les outils respectent les droits : un starter ne peut rien préparer, ni voir un autre golf', async () => {
    const f = await createClub(db);
    const other = await createClub(db, { organizationId: f.organizationId });
    const p = await principal(f, 'starter');
    const results: Array<{ content: string; is_error?: boolean }> = [];
    const model = new ScriptedModel([
      call('propose_booking', { tee_times: [{ course_id: f.courseId, date: '2030-06-03', time: '08:00', players: 2, holes: 18 }],
        new_customer: { last_name: 'X', phone: '0600000000' } }),
      (req) => { results.push(lastResult(req)); return call('get_tee_sheet', { course_id: other.courseId, date: '2030-06-03' })(req); },
      (req) => { results.push(lastResult(req)); return call('search_golfers', { club_id: f.clubId, query: 'a' })(req); },
      (req) => { results.push(lastResult(req)); return { content: [{ type: 'text', text: 'Je ne peux pas.' }] }; },
    ]);
    await runAssistantTurn({ ...deps(db), model }, p, { message: 'test' });
    expect(results.map((r) => r.is_error)).toEqual([true, true, true]);
    expect(results.every((r) => r.content.startsWith('FORBIDDEN'))).toBe(true);
  });

  it('un brouillon expiré ou abandonné ne peut plus être confirmé', async () => {
    const f = await createClub(db);
    const p = await principal(f, 'receptionist');
    const script = () => new ScriptedModel([
      call('propose_booking', { tee_times: [{ course_id: f.courseId, date: DAY, time: '09:00', players: 2, holes: 18 }],
        new_customer: { last_name: 'Tazi', email: 'tazi@example.com' } }),
      say('Brouillon prêt.'),
    ]);
    const t1 = await runAssistantTurn({ ...deps(db), model: script() }, p, { message: 'x' });
    await expect(confirmDraft(deps(db, new Date(NOW.getTime() + 31 * 60_000)), p, t1.drafts[0]!.id)).rejects.toMatchObject({ code: 'DRAFT_EXPIRED' });
    const t2 = await runAssistantTurn({ ...deps(db), model: script() }, p, { message: 'x' });
    await cancelDraft(db, p, t2.drafts[0]!.id);
    await expect(confirmDraft(deps(db), p, t2.drafts[0]!.id)).rejects.toMatchObject({ code: 'DRAFT_EXPIRED' });
  });

  it('sans clé API, l’IA répond « non configurée » ; le reste fonctionne', async () => {
    const f = await createClub(db);
    const app = buildServer({ db, now: () => NOW });
    const email = `ai.nokey.${Date.now()}@test.ma`;
    await createStaffUser(db, { organizationId: f.organizationId, email, password: 'motdepasse-test', displayName: 'R', roles: [{ clubId: f.clubId, role: 'club_admin' }] });
    const token = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password: 'motdepasse-test' } })).json().token;
    const h = { authorization: `Bearer ${token}` };
    expect((await app.inject({ method: 'GET', url: '/api/ai/status' })).json()).toEqual({ configured: false, model: null });
    const r = await app.inject({ method: 'POST', url: '/api/ai/assistant', headers: h, payload: { message: 'bonjour' } });
    expect(r.statusCode).toBe(503);
    expect(r.json().error.code).toBe('AI_NOT_CONFIGURED');
    const data = await app.inject({ method: 'GET', url: `/api/clubs/${f.clubId}/reports/data?from=${DAY}&to=${DAY}`, headers: h });
    expect(data.statusCode).toBe(200);
    await app.close();
  });
});

describe('rapports', () => {
  it('calcule les chiffres en base ; l’IA ne reçoit que ces chiffres et rédige', async () => {
    const f = await createClub(db);
    const a = await createBooking(deps(db), staff, { courseId: f.courseId, startsAt: at('08:00'), players: 4, holes: 18 });
    await createBooking(deps(db), staff, { courseId: f.courseId, startsAt: at('08:06'), players: 2, holes: 9, options: [{ code: 'CART', quantity: 1 }] });
    await recordStaffPayment(db, a.booking.id, { amountMinor: 100000, method: 'cash' }, staff.actor);

    const data = await computeReportData(db, f.clubId, DAY, DAY);
    expect(data.activity).toMatchObject({ teeTimesUsed: 2, bookings: 2, players: 6, capacityPlayers: 400, occupancyRate: 0.015 });
    expect(data.activity.byHoles).toEqual({ '9': 2, '18': 4 });
    expect(data.revenue.totalMinor).toBe(4 * 130000 + 20000 + 2 * 75000 + 10000);
    expect(data.revenue.collectedMinor).toBe(100000);
    expect(data.revenue.outstandingMinor).toBe(data.revenue.totalMinor - 100000);
    expect(data.caddies.teeTimesWithCaddie).toBe(2);
    expect(data.equipment).toEqual([{ code: 'CART', name: 'Voiturette', units: 1 }]);

    const model = new ScriptedModel([say('# Rapport\n\n## Synthèse\nActivité faible.')]);
    const p = await principal(f, 'club_admin');
    const report = await generateReport(db, model, { clubId: f.clubId, from: DAY, to: DAY, focus: 'les caddies', locale: 'en', actor: { type: 'user', id: p.userId } });
    expect(report.content).toContain('Synthèse');
    const sent = (model.requests[0]!.messages[0]!.content as string);
    expect(sent).toContain('"players":6');
    expect(sent).toContain('English');
    expect(sent).toContain('les caddies');
    expect(JSON.stringify(model.requests[0])).not.toMatch(/Alami|@/); // aucune donnée personnelle envoyée
  });
});
