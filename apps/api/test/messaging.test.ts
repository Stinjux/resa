import { describe, expect, it } from 'vitest';
import type { AiModel, AiRequest } from '../src/modules/ai/model.js';
import { createStaffUser, loadPrincipal } from '../src/modules/auth/service.js';
import type { Role } from '../src/modules/auth/permissions.js';
import { createBooking } from '../src/modules/booking/service.js';
import { createMessagingRegistry } from '../src/integrations/messaging/registry.js';
import { MessagingError, type MessagingConnector } from '../src/integrations/messaging/contract.js';
import {
  approveRequest, getThread, listInbox, processMessagingQueue, receiveInbound, rejectRequest,
} from '../src/modules/messaging/service.js';
import { normalizePhone } from '../src/modules/messaging/phone.js';
import { DAY, NOW, at, createClub, deps, staff, useTestDb, type Fixture } from './helpers.js';

const db = useTestDb();

type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown };
type Step = (req: AiRequest) => Block[];
class ScriptedModel implements AiModel {
  readonly name = 'test';
  requests: AiRequest[] = [];
  constructor(private steps: Step[]) {}
  async create(req: AiRequest) {
    this.requests.push(structuredClone(req));
    const content = this.steps.shift()!(req);
    return { id: 'm', type: 'message', role: 'assistant', model: 'test', content, stop_sequence: null,
      stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } } as never;
  }
}
const say = (text: string): Step => () => [{ type: 'text', text }];
const call = (name: string, input: unknown): Step => () => [{ type: 'tool_use', id: `t${Math.random()}`, name, input }];
const lastToolResult = (req: AiRequest) =>
  (req.messages.at(-1)!.content as Array<{ type: string; content: string; is_error?: boolean }>).find((b) => b.type === 'tool_result')!;

let n = 0;
async function principal(f: Fixture, role: Role) {
  const id = await createStaffUser(db, { organizationId: f.organizationId, email: `msg.${role}.${++n}.${Date.now()}@test.ma`,
    password: 'motdepasse-test', displayName: `${role} test`, roles: [{ clubId: f.clubId, role }] });
  return (await loadPrincipal(db, id))!;
}

async function messagingClub(opts = {}) {
  const f = await createClub(db, opts);
  await db.query(`UPDATE clubs SET messaging_provider = 'local', country_code = 'MA' WHERE id = $1`, [f.clubId]);
  return f;
}

let seq = 0;
function inbound(f: Fixture, text: string, from = '06 12 34 56 78') {
  return receiveInbound(db, f.clubId, 'local', { channel: 'whatsapp', from, to: null, fromName: 'Youssef', text,
    providerMessageId: `wamid.${++seq}.${Date.now()}`, receivedAt: NOW });
}
const outbound = async (threadId: string) => (await getThread(db, threadId)).messages.filter((m: { direction: string }) => m.direction === 'out');

describe('réservation par WhatsApp / SMS avec validation obligatoire', () => {
  it('l’IA recueille la demande ; rien n’est réservé avant la validation par la réception', async () => {
    const f = await messagingClub();
    const model = new ScriptedModel([
      say('Avec plaisir ! Pour combien de joueurs, en 9 ou 18 trous, et à quel nom ?'),
      call('find_available_tee_times', { date: DAY, players: 4, holes: 18, from_time: '13:00', to_time: '13:30' }),
      (req) => {
        const r = JSON.parse(lastToolResult(req).content);
        expect(r.free_times.slice(0, 2)).toEqual(['13:00', '13:06']);
        return call('submit_booking_request', { tee_times: ['13:00', '13:06'].map((time) => ({ date: DAY, time, players: 4, holes: 18 })),
          first_name: 'Youssef', last_name: 'Alami', language: 'fr' })(req);
      },
      say('Merci Youssef ! Votre demande (13:00 et 13:06) est transmise au golf pour validation.'),
    ]);
    const d = { ...deps(db), ai: model, messaging: createMessagingRegistry() };

    const m1 = await inbound(f, 'Bonjour, je voudrais 2 départs à 13h le 10 juin');
    await processMessagingQueue(d, NOW);
    // Le contexte du golf est fourni, sans aucune donnée d'autres clients.
    expect(JSON.stringify(model.requests[0]!.messages)).toContain('[Contexte fourni par le golf]');
    let out = await outbound(m1.threadId);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ author: 'ai', status: 'sent' });

    await inbound(f, '4 joueurs chacun, 18 trous, Youssef Alami');
    await processMessagingQueue(d, NOW);
    const thread = await getThread(db, m1.threadId);
    expect(thread.contact).toBe('+212612345678');
    expect(thread.requests).toHaveLength(1);
    expect(thread.requests[0]).toMatchObject({ status: 'pending' });
    expect(thread.requests[0].summary.totalMinor).toBe(2 * (4 * 130000 + 20000));
    const count = await db.query('SELECT count(*)::int AS n FROM bookings WHERE club_id = $1', [f.clubId]);
    expect(count.rows[0].n).toBe(0); // aucune réservation sans validation

    // Le starter ne peut pas valider ; la réceptionniste oui.
    await expect(approveRequest(d, await principal(f, 'starter'), thread.requests[0].id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const reception = await principal(f, 'receptionist');
    await approveRequest(d, reception, thread.requests[0].id);
    await approveRequest(d, reception, thread.requests[0].id); // double clic sans effet
    await processMessagingQueue(d, NOW);

    const bookings = await db.query(`SELECT reference, channel, players, customer_id FROM bookings WHERE club_id = $1 ORDER BY reference`, [f.clubId]);
    expect(bookings.rows).toHaveLength(2);
    expect(bookings.rows.every((b) => b.channel === 'whatsapp' && b.players === 4)).toBe(true);
    const customer = await db.query('SELECT first_name, last_name, phone FROM customers WHERE id = $1', [bookings.rows[0].customer_id]);
    expect(customer.rows[0]).toEqual({ first_name: 'Youssef', last_name: 'Alami', phone: '+212612345678' });

    const after = await getThread(db, m1.threadId);
    expect(after.requests[0]).toMatchObject({ status: 'approved', decidedBy: 'receptionist test' });
    out = await outbound(m1.threadId);
    const confirmation = out.at(-1)!;
    expect(confirmation.body).toContain('Réservation confirmée');
    expect(confirmation.body).toContain(bookings.rows[0].reference);
    const log = await db.query(`SELECT actor_id FROM audit_log WHERE action = 'booking_request.approved' AND entity_id = $1`, [thread.requests[0].id]);
    expect(log.rows[0].actor_id).toBe(reception.userId);
  });

  it('un directeur peut refuser ; le client est prévenu dans sa langue', async () => {
    const f = await messagingClub();
    const model = new ScriptedModel([
      call('submit_booking_request', { tee_times: [{ date: DAY, time: '09:00', players: 2, holes: 18 }], last_name: 'Smith', language: 'en' }),
      say('Your request has been sent to the club.'),
    ]);
    const d = { ...deps(db), ai: model, messaging: createMessagingRegistry() };
    const m = await inbound(f, 'Hi, 2 players 18 holes at 9am on June 10, John Smith');
    await processMessagingQueue(d, NOW);
    const req = (await getThread(db, m.threadId)).requests[0];
    await rejectRequest(d, await principal(f, 'club_admin'), req.id, 'Compétition ce matin-là.');
    await processMessagingQueue(d, NOW);
    const last = (await outbound(m.threadId)).at(-1)!;
    expect(last.body).toContain('Sorry');
    expect(last.body).toContain('Compétition');
    await expect(approveRequest(d, await principal(f, 'receptionist'), req.id)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('si le créneau est pris avant la validation, la demande reste en attente avec l’erreur', async () => {
    const f = await messagingClub();
    const model = new ScriptedModel([
      call('submit_booking_request', { tee_times: [{ date: DAY, time: '10:00', players: 4, holes: 18 }], last_name: 'Tazi', language: 'fr' }),
      say('Demande transmise.'),
    ]);
    const d = { ...deps(db), ai: model, messaging: createMessagingRegistry() };
    const m = await inbound(f, 'x');
    await processMessagingQueue(d, NOW);
    await createBooking(deps(db), staff, { courseId: f.courseId, startsAt: at('10:00'), players: 1, holes: 18 }); // pris entre-temps
    const req = (await getThread(db, m.threadId)).requests[0];
    await expect(approveRequest(d, await principal(f, 'receptionist'), req.id)).rejects.toMatchObject({ code: 'TEE_TIME_FULL' });
    const again = (await getThread(db, m.threadId)).requests[0];
    expect(again.status).toBe('pending');
    expect(again.lastError).toContain('Places restantes');
  });

  it('l’agent client ne peut ni voir un autre golf ni demander un créneau indisponible', async () => {
    const f = await messagingClub();
    const other = await createClub(db, { organizationId: f.organizationId });
    const results: Array<{ content: string; is_error?: boolean }> = [];
    const model = new ScriptedModel([
      call('find_available_tee_times', { course_id: other.courseId, date: DAY, players: 2, holes: 18 }),
      (req) => { results.push(lastToolResult(req)); return call('submit_booking_request', { tee_times: [{ date: DAY, time: '08:03', players: 2, holes: 18 }], last_name: 'X', language: 'fr' })(req); },
      (req) => { results.push(lastToolResult(req)); return [{ type: 'text', text: 'Désolé.' }]; },
    ]);
    const m = await inbound(f, 'x');
    await processMessagingQueue({ ...deps(db), ai: model, messaging: createMessagingRegistry() }, NOW);
    expect(results.map((r) => r.is_error)).toEqual([true, true]);
    expect(results[0]!.content).toContain('FORBIDDEN');
    expect(results[1]!.content).toContain('SLOT_NOT_AVAILABLE');
    expect((await getThread(db, m.threadId)).requests).toHaveLength(0);
  });

  it('messages en double ignorés ; sans IA, accusé de réception et traitement par le personnel', async () => {
    const f = await messagingClub();
    const msg = { channel: 'sms' as const, from: '+212 600 000 001', to: null, fromName: null, text: 'Bonjour', providerMessageId: `dup-${Date.now()}`, receivedAt: NOW };
    const a = await receiveInbound(db, f.clubId, 'local', msg);
    const b = await receiveInbound(db, f.clubId, 'local', msg);
    expect(b).toMatchObject({ threadId: a.threadId, duplicate: true });
    await processMessagingQueue({ ...deps(db), ai: null, messaging: createMessagingRegistry() }, NOW);
    const out = await outbound(a.threadId);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ author: 'system' });
    expect(out[0].body).toContain('vous répond au plus vite');
    const inbox = await listInbox(db, f.clubId);
    expect(inbox[0]).toMatchObject({ id: a.threadId, contact: '+212600000001' });
  });

  it('envoi : nouvel essai en cas de panne du fournisseur', async () => {
    const f = await createClub(db);
    await db.query(`UPDATE clubs SET messaging_provider = 'flaky', country_code = 'MA' WHERE id = $1`, [f.clubId]);
    let calls = 0;
    const flaky: MessagingConnector = { provider: 'flaky', channels: ['sms'], async send() {
      if (++calls === 1) throw new MessagingError('503', true);
      return { providerMessageId: 'ok-1' };
    } };
    const d = { ...deps(db), ai: null, messaging: createMessagingRegistry([flaky]) };
    const m = await receiveInbound(db, f.clubId, 'flaky', { channel: 'sms', from: '0600000002', to: null, fromName: null, text: 'Salut', providerMessageId: `f-${Date.now()}`, receivedAt: NOW });
    await processMessagingQueue(d, NOW);
    expect((await outbound(m.threadId))[0]).toMatchObject({ status: 'pending', lastError: '503' });
    await processMessagingQueue(d, new Date(NOW.getTime() + 60_000));
    expect((await outbound(m.threadId))[0]).toMatchObject({ status: 'sent' });
  });

  it('normalise les numéros marocains et internationaux', () => {
    expect(normalizePhone('06 12 34 56 78', 'MA')).toBe('+212612345678');
    expect(normalizePhone('whatsapp:+212612345678', 'MA')).toBe('+212612345678');
    expect(normalizePhone('0033 6 12 34 56 78', 'MA')).toBe('+33612345678');
  });
});
