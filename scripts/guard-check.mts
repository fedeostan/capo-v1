// Guard check — the deterministic half of the write-authorization gate.
//
// The guard (packages/core/src/capabilities/guard.ts) is the single highest-risk
// piece of pure logic in this repo: it is what decides whether an instruction to
// Capo changes the real board immediately or waits behind an approval card. It
// is 60 lines, it has no I/O in its decision, and until now it had no assertions
// at all. Like `pnpm scheduler-check` and `pnpm whatsapp-check` (and unlike
// `pnpm agent-smoke`) this needs NO credentials, no network and no model, so it
// runs in CI on every PR.
//
// It guards six things, and each of them fails SILENTLY in production:
//
//   1. The posture branch (issue #57). Under `always_ask` a matching quote must
//      still produce a card. A regression here does not error — it just starts
//      writing to a live job without asking, which is the exact complaint the
//      setting was built for.
//   2. The `trust_quote` path must keep behaving EXACTLY as it did before 0031.
//      Breaking it does not error either: every direct write silently degrades
//      into an approval card and the product just becomes annoying.
//   3. The accent/whitespace normalisation in matchesManagerInstruction. A
//      manager types "vamos começar a pintura"; the model quotes it back; if the
//      comparison stops folding accents, the quote stops matching and (2)
//      happens for Portuguese only — the one language every real user speaks.
//   4. That the decision is genuinely a function of the posture ALONE under
//      always_ask. Nothing the model emits — a real quote, a fabricated one, no
//      quote at all — may reach the direct-write branch.
//   5. WHAT MAY BECOME EVIDENCE IN THE FIRST PLACE (issue #47). The guard
//      matches quotes against `thread.recentUserTexts`, which toThread() builds
//      from `messages` rows whose role is 'user'. Since #47 the system writes
//      `role='event'` rows into that same table several times a day — the
//      morning briefing note, the check-in note, one note per crew member who
//      answers it. If any of them ever counted as evidence, a line Capo wrote
//      itself would authorize a direct write the moment the model quoted it
//      back, with no error and no card. That filter is one clause in one
//      function, so it is asserted here.
//   6. The duplicate refusal (issue #124). createProposalForCompany refuses a
//      card whose normalized args match one already `pending` on the same
//      conversation. Too loose and a genuinely different change is silently
//      swallowed; too strict and the 14 Aug duplicates come back. Both edges
//      are pinned below, on the normalization and through the real runGuarded.
//
// The last block runs the REAL runGuarded end to end against a fake `Db`, so
// this file also pins the wiring: that runGuarded consults ctx.confirmPosture at
// all, and that the proposal path still produces a card. A pure-function check
// alone would keep passing if somebody deleted the call.
//
// Run with `pnpm guard-check`. Exit 0 = green, 1 = at least one failure.

import type { Db } from '@capo/db/client';
import { CONFIRM_POSTURES, coerceConfirmPosture, DEFAULT_CONFIRM_POSTURE } from '@capo/db/posture';
import { decideGuard, matchesManagerInstruction, runGuarded } from '@capo/core/capabilities/guard';
import { getProposableTool, proposalArgsKey } from '@capo/core/capabilities/propose';
import { RenderError, renderProposal } from '@capo/core/capabilities/render';
import type { CapoTool, ToolContext } from '@capo/core/capabilities/types';
// The evidence pool is BUILT here, not in the guard. Since #47 the system
// writes into `messages` several times a day, so what toThread lets into
// recentUserTexts is now as load-bearing as what the guard does with it.
import { toThread, type ThreadWindow } from '@capo/core/conversation';

let failures = 0;
const lines: string[] = [];

function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures += 1;
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function eq(name: string, actual: unknown, expected: unknown) {
  check(name, actual === expected, `got ${String(actual)}, want ${String(expected)}`);
}

// ── the posture itself ──────────────────────────────────────────────────────
// The default is the safe one, and every unreadable value resolves to it. If
// this ever flips, nothing else in this file would notice: every check below
// passes its posture explicitly.
eq('the default posture is always_ask', DEFAULT_CONFIRM_POSTURE, 'always_ask');
eq('there are exactly two postures', CONFIRM_POSTURES.length, 2);
eq('a missing column (pre-0031 bundle) coerces to always_ask', coerceConfirmPosture(undefined), 'always_ask');
eq('a null coerces to always_ask', coerceConfirmPosture(null), 'always_ask');
eq('an unrecognised value coerces to always_ask', coerceConfirmPosture('yolo'), 'always_ask');
eq('a stored trust_quote survives the coerce', coerceConfirmPosture('trust_quote'), 'trust_quote');

// ── matchesManagerInstruction ───────────────────────────────────────────────
// The evidence check, unchanged by #57 and asserted here for the first time.
const said = ['Podes criar a tarefa de pintura para amanhã?'];

check('an exact substring matches', matchesManagerInstruction('criar a tarefa de pintura', said));
check('the whole message matches itself', matchesManagerInstruction(said[0]!, said));
check(
  'accents are folded on BOTH sides',
  matchesManagerInstruction('criar a tarefa de pintura para amanha', said),
);
check(
  'accents are folded when the QUOTE carries them and the message does not',
  matchesManagerInstruction('começar', ['vamos comecar a pintura hoje']),
);
check(
  'runs of whitespace collapse',
  matchesManagerInstruction('criar   a\n tarefa', said),
);
check('case is folded', matchesManagerInstruction('CRIAR A TAREFA', said));
check('a quote the manager never said does not match', !matchesManagerInstruction('cancela a obra', said));
check('a quote shorter than 4 chars never matches', !matchesManagerInstruction('cri', said));
check(
  'a 3-char quote is refused even when it IS present verbatim',
  !matchesManagerInstruction('tar', said),
);
check('an empty evidence pool matches nothing', !matchesManagerInstruction('criar a tarefa', []));
check(
  'the newest message is searched too, not only the first',
  matchesManagerInstruction('cancela a obra', ['bom dia', 'cancela a obra Teste QA']),
);

// ── proposalArgsKey: what counts as "the same card" (issue #124) ────────────
// The normalization behind the duplicate refusal in createProposalForCompany.
// The live evidence it is built for: two racing turns regenerated the same
// three add_worker cards with only `trade` capitalised differently. So: fold
// case, sort object keys, and NOTHING else — a different phone, date, id, or
// an extra field is a different proposal, and swallowing one of those would be
// a worse bug than the duplicate it prevents.

eq(
  "the 14 Aug case: 'trolha' vs 'Trolha' is the same card",
  proposalArgsKey({ name: 'Rui', phone: '+351912345678', trade: 'trolha' }),
  proposalArgsKey({ name: 'Rui', phone: '+351912345678', trade: 'Trolha' }),
);
check(
  'object key order does not matter',
  proposalArgsKey({ a: 1, b: 'X' }) === proposalArgsKey({ b: 'x', a: 1 }),
);
check(
  'strings fold case at any depth',
  proposalArgsKey({ tasks: [{ title: 'Pintar Tecto' }] }) === proposalArgsKey({ tasks: [{ title: 'pintar tecto' }] }),
);
check(
  'a different phone is a different card',
  proposalArgsKey({ name: 'Rui', phone: '+351912345678' }) !== proposalArgsKey({ name: 'Rui', phone: '+351912345679' }),
);
check(
  'an extra field is a different card',
  proposalArgsKey({ name: 'Rui' }) !== proposalArgsKey({ name: 'Rui', trade: 'trolha' }),
);
check(
  'a number is not the string of itself',
  proposalArgsKey({ duration: 3 }) !== proposalArgsKey({ duration: '3' }),
);
check(
  'array order is a real difference — erring toward a second card is the safe direction',
  proposalArgsKey({ ids: ['a', 'b'] }) !== proposalArgsKey({ ids: ['b', 'a'] }),
);
check(
  'accents are NOT folded: José and Jose are different values, unlike in the quote match above',
  proposalArgsKey({ name: 'José' }) !== proposalArgsKey({ name: 'Jose' }),
);

// ── WHAT MAY BECOME EVIDENCE AT ALL (issue #47) ─────────────────────────────
//
// Everything above asks whether a quote MATCHES the evidence pool. This asks
// what is allowed INTO that pool, which is the half a prompt cannot protect.
//
// The pool is `thread.recentUserTexts`, built by toThread() from the last three
// `messages` rows whose role is 'user'. Since #47 the system itself writes into
// `messages` far more often than it used to — the 07:00 briefing note, the
// late-afternoon check-in note, and one note per crew member answering that
// check-in. All of them are `role='event'`.
//
// If an event row ever counted as evidence, a system-authored line — or worse,
// anything a crew member could influence the wording of — would authorize a
// DIRECT manager-level write the moment the model quoted it back. Nothing would
// error; the card would simply stop appearing. The filter is one clause in
// toThread and it is the entire structural protection, so it is pinned here
// rather than left to review.
{
  const row = (id: string, role: string, text: string) =>
    ({
      id,
      role,
      channel: 'system',
      content: { parts: [{ type: 'text', text }] },
      content_format: 'ui-message@7',
      conversation_id: 'c',
      created_at: '2026-08-14T06:00:00Z',
    }) as unknown as ThreadWindow['rows'][number];

  const EVENT = 'Bom dia. Hoje há 3 tarefas em curso. Enviei o resumo do dia a 2 pessoas: Zé, Ana.';
  const ANSWER = 'Zé respondeu ao check-in: diz que acabou o trabalho de hoje (2 tarefas).';

  const thread = toThread({
    summary: null,
    rows: [
      row('1', 'event', EVENT),
      row('2', 'user', 'bom dia'),
      row('3', 'assistant', 'bom dia, chefe'),
      row('4', 'event', ANSWER),
    ],
  });

  eq('only the real manager row is evidence', thread.recentUserTexts.length, 1);
  eq('and it is the one the manager actually typed', thread.recentUserTexts[0], 'bom dia');
  check(
    "the morning briefing note is NOT evidence, though the model does see it",
    !thread.recentUserTexts.includes(EVENT),
  );
  check(
    "a crew member's check-in answer is NOT evidence either",
    !thread.recentUserTexts.includes(ANSWER),
  );
  check(
    'neither of them could authorize a direct write by being quoted back',
    !matchesManagerInstruction('Enviei o resumo do dia', thread.recentUserTexts) &&
      !matchesManagerInstruction('acabou o trabalho de hoje', thread.recentUserTexts),
  );

  // The other half: an event row is still shown to the model, tagged, so this
  // check cannot be "fixed" by dropping events from the thread entirely — that
  // would put issue #47 straight back.
  eq('all four rows still reach the model', thread.uiMessages.length, 4);
  check(
    'and an event reaches it tagged as a system event, not as the manager',
    JSON.stringify(thread.uiMessages[0]?.parts ?? []).includes('<system-event>'),
  );
}

// ── decideGuard: the posture branch (issue #57) ─────────────────────────────
// The whole matrix. `posture × (matching quote | wrong quote | too short | none)`.
const EXACT = 'criar a tarefa de pintura';

eq(
  'trust_quote executes on an exact match',
  decideGuard('trust_quote', EXACT, said).act,
  'execute',
);
eq(
  'trust_quote executes on an accent-insensitive match',
  decideGuard('trust_quote', 'criar a tarefa de pintura para amanha', said).act,
  'execute',
);
eq(
  'trust_quote PROPOSES when the quote is absent from the thread',
  decideGuard('trust_quote', 'cancela a obra Teste QA', said).act,
  'propose',
);
eq('trust_quote PROPOSES on a quote under 4 chars', decideGuard('trust_quote', 'cri', said).act, 'propose');
eq('trust_quote PROPOSES when no quote was supplied at all', decideGuard('trust_quote', undefined, said).act, 'propose');
eq('trust_quote PROPOSES on an empty-string quote', decideGuard('trust_quote', '', said).act, 'propose');
eq(
  'trust_quote PROPOSES when the evidence pool is empty',
  decideGuard('trust_quote', EXACT, []).act,
  'propose',
);

// The four that ARE #57. Same inputs as above; the answer must be 'propose'
// every time, including the first — a verified verbatim quote.
eq(
  'always_ask PROPOSES even on an exact verbatim match',
  decideGuard('always_ask', EXACT, said).act,
  'propose',
);
eq(
  'always_ask PROPOSES on an accent-insensitive match too',
  decideGuard('always_ask', 'criar a tarefa de pintura para amanha', said).act,
  'propose',
);
eq('always_ask PROPOSES with no quote', decideGuard('always_ask', undefined, said).act, 'propose');
eq('always_ask PROPOSES with a fabricated quote', decideGuard('always_ask', 'cancela tudo', said).act, 'propose');

// Neither posture can REJECT. This is the property that makes the guard safe to
// be wrong about: the worst outcome on any branch is one extra approval card.
for (const posture of CONFIRM_POSTURES) {
  for (const quote of [EXACT, 'cri', 'cancela tudo', undefined]) {
    const act = decideGuard(posture, quote, said).act;
    check(
      `${posture} + ${quote === undefined ? 'no quote' : `"${quote}"`} yields execute or propose, never a refusal`,
      act === 'execute' || act === 'propose',
      `got ${act}`,
    );
  }
}

// always_ask must not consult the quote AT ALL — not merely arrive at the same
// answer by a stricter comparison. If a future change made the reason text vary
// with the quote, the posture would have become a match-strictness dial instead
// of an off switch, and #57 would be half-reopened.
{
  const reasons = new Set(
    [EXACT, 'cri', 'cancela tudo', undefined, ''].map(q => {
      const d = decideGuard('always_ask', q, said);
      return d.act === 'propose' ? d.reason : `EXECUTED(${String(q)})`;
    }),
  );
  eq('always_ask gives one identical answer whatever the quote is', reasons.size, 1);
}

// The two proposal reasons are different strings, because the model has to say
// something different: "your setting asked me to check" is not "I could not
// verify you said that".
{
  const alwaysAsk = decideGuard('always_ask', EXACT, said);
  const noMatch = decideGuard('trust_quote', 'cancela tudo', said);
  check(
    'the always_ask reason is distinguishable from the no-match reason',
    alwaysAsk.act === 'propose' &&
      noMatch.act === 'propose' &&
      alwaysAsk.reason !== noMatch.reason &&
      alwaysAsk.reason.length > 0,
  );
}

// ── runGuarded, end to end ──────────────────────────────────────────────────
// Proves the wiring, not just the arithmetic: that runGuarded reads
// ctx.confirmPosture, that the execute branch runs the tool with actor
// 'manager', and that the propose branch really reaches createProposal and
// stores a card.
//
// The fake Db answers exactly two queries — the proposals insert, and the
// duplicate-refusal SELECT that #124 put in front of it. `create_job` is
// used because its card renders from action_args alone with no lookups
// (render.ts), so no other table has to be faked. The tool handed to runGuarded
// is the REAL create_job with only its `execute` swapped for a recorder, so the
// schema and the rendered card are the production ones and cannot drift from
// what this file asserts.
{
  // insert() stamps the id and the DB-default status, because the dedup SELECT
  // filters on `status = 'pending'` and a real insert never sends status.
  const inserted: Record<string, unknown>[] = [];
  const fakeDb = {
    from(table: string) {
      if (table !== 'proposals') throw new Error(`guard-check: unexpected table ${table}`);
      return {
        select(_columns: string) {
          const filters: Array<[string, unknown]> = [];
          const builder = {
            eq(column: string, value: unknown) {
              filters.push([column, value]);
              return builder;
            },
            then(resolve: (value: { data: Record<string, unknown>[]; error: null }) => void) {
              resolve({
                data: inserted.filter(row => filters.every(([column, value]) => row[column] === value)),
                error: null,
              });
            },
          };
          return builder;
        },
        insert(row: Record<string, unknown>) {
          const stored = { ...row, id: `proposal-${inserted.length + 1}`, status: 'pending' };
          inserted.push(stored);
          return {
            select: () => ({
              single: async () => ({ data: stored, error: null }),
            }),
          };
        },
      };
    },
  } as unknown as Db;

  const realCreateJob = getProposableTool('create_job');
  if (!realCreateJob) throw new Error('guard-check: create_job is no longer a proposable tool');

  let executed = 0;
  let executedActor: string | null = null;
  const spyTool: CapoTool = {
    ...realCreateJob,
    async execute(_input, ctx) {
      executed += 1;
      executedActor = ctx.actor;
      return { ok: true };
    },
  };

  const ctxFor = (
    posture: 'always_ask' | 'trust_quote',
    conversationId = '22222222-2222-2222-2222-222222222222',
  ): ToolContext => ({
    companyId: '11111111-1111-1111-1111-111111111111',
    conversationId,
    db: fakeDb,
    actor: 'manager',
    recentUserTexts: ['cria a obra Casa do Zé'],
    userId: '33333333-3333-3333-3333-333333333333',
    confirmPosture: posture,
    appUrl: 'https://www.construcapo.com',
    // No channel in a credential-free check. The guard never consults it.
    messageWorker: null,
    locales: { user: 'pt-PT', company: 'pt-PT' },
  });

  const args = { name: 'Casa do Zé', manager_instruction: 'cria a obra Casa do Zé' };

  const trusted = await runGuarded(spyTool, { ...args }, ctxFor('trust_quote'));
  eq('runGuarded executes under trust_quote with a matching quote', trusted.status, 'executed');
  eq('and the tool actually ran', executed, 1);
  eq("and it ran as the manager, so tasks.source records a manager write", executedActor, 'manager');
  eq('and no card was stored', inserted.length, 0);

  const asked = await runGuarded(spyTool, { ...args }, ctxFor('always_ask'));
  eq('runGuarded PROPOSES under always_ask with the SAME matching quote', asked.status, 'proposed');
  eq('and the tool did NOT run', executed, 1);
  eq('and exactly one card was stored', inserted.length, 1);
  eq('the card is filed against the tool that was called', inserted[0]?.action_name, 'create_job');
  check(
    'the stored card text is rendered from the args, not model-authored',
    typeof inserted[0]?.rendered_text === 'string' && (inserted[0]!.rendered_text as string).includes('Casa do Zé'),
    String(inserted[0]?.rendered_text),
  );
  check(
    'manager_instruction is stripped from the stored payload',
    !Object.prototype.hasOwnProperty.call((inserted[0]?.action_args ?? {}) as object, 'manager_instruction'),
    JSON.stringify(inserted[0]?.action_args),
  );
  check(
    'the proposed result carries a reason the model can relay',
    asked.status === 'proposed' && asked.reason.length > 0 && asked.renderedText.length > 0,
  );

  // ── the duplicate refusal, through the REAL runGuarded (issue #124) ───────
  // The card stored above ({ name: 'Casa do Zé' }) is still pending. The 14
  // Aug duplicates were regenerated, not replayed — same people, same phones,
  // `trade` differing only in case — so the twin here flips case and must
  // still be refused.
  const caseFlip = await runGuarded(
    spyTool,
    { name: 'CASA DO ZÉ', manager_instruction: 'cria a obra Casa do Zé' },
    ctxFor('always_ask'),
  );
  eq('an identical card differing only in case is refused', caseFlip.status, 'already_pending');
  eq('and no second card was stored', inserted.length, 1);
  check(
    'the refusal names the existing card, so the model knows which one is waiting',
    caseFlip.status === 'already_pending' && caseFlip.proposalId === inserted[0]!.id,
  );
  check(
    "and its message reads as settled-and-waiting, never as an error to retry",
    caseFlip.status === 'already_pending' &&
      /already/i.test(caseFlip.message) &&
      /do not retry/i.test(caseFlip.message),
  );
  check(
    "it is NOT status 'proposed', the literal both channels render a card from — so no second card can reach the manager",
    (caseFlip as { status: string }).status !== 'proposed',
  );

  const different = await runGuarded(
    spyTool,
    { name: 'Casa da Ana', manager_instruction: 'cria a obra Casa do Zé' },
    ctxFor('always_ask'),
  );
  eq('genuinely different args still get their own card', different.status, 'proposed');
  eq('stored as a second row', inserted.length, 2);

  const otherConversation = await runGuarded(
    spyTool,
    { name: 'Casa do Zé', manager_instruction: 'cria a obra Casa do Zé' },
    ctxFor('always_ask', '99999999-9999-9999-9999-999999999999'),
  );
  eq('the same args on a DIFFERENT conversation are not a duplicate', otherConversation.status, 'proposed');
  eq('and stored as a third row', inserted.length, 3);

  // A resolved twin must not block: only a card the manager has NOT answered
  // yet counts. Flip the original to approved and file the same args again.
  inserted[0]!.status = 'approved';
  const afterResolve = await runGuarded(
    spyTool,
    { name: 'Casa do Zé', manager_instruction: 'cria a obra Casa do Zé' },
    ctxFor('always_ask'),
  );
  eq('a non-pending twin does not block a new card', afterResolve.status, 'proposed');
  eq('and it was stored as a fourth row', inserted.length, 4);
}

// ── the card a consent-only update_worker draws (issue #157) ────────────────
// Every guarded write under always_ask, which is the default and therefore
// every manager, has to be RENDERED into a card before it can be approved. A
// field the renderer does not know about produces an empty change list and
// throws "empty change" at the manager, and until #157 whatsapp_opt_in was such
// a field.
//
// That made the single sentence that turns a crew member from unreachable into
// reachable the one sentence that failed: consent is the gate on every
// proactive send (hasWhatsAppConsent fails closed), so without it that person
// gets no 07:00 message, no check-in and no welcome, for ever.
//
// The renderer is asserted here rather than in a file of its own because this
// is the gate that already owns "what happens between the manager speaking and
// the write landing". It runs the REAL renderProposal against a fake Db, in all
// three languages, so a missing translation is caught as a failure rather than
// as an undefined printed onto a card.
{
  const cardDb = {
    from(table: string) {
      if (table !== 'workers') throw new Error(`guard-check: unexpected table ${table}`);
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: { name: 'Zé' }, error: null }),
      };
      return builder;
    },
  } as unknown as Db;

  const companyId = '11111111-1111-1111-1111-111111111111';
  const workerId = '44444444-4444-4444-4444-444444444444';
  const card = (args: Record<string, unknown>, locale: 'pt-PT' | 'es-ES' | 'en-US') =>
    renderProposal(cardDb, companyId, 'update_worker', args, locale);

  for (const locale of ['pt-PT', 'es-ES', 'en-US'] as const) {
    let granted = '';
    let withdrawn = '';
    let threw: unknown = null;
    try {
      granted = await card({ worker_id: workerId, whatsapp_opt_in: true }, locale);
      withdrawn = await card({ worker_id: workerId, whatsapp_opt_in: false }, locale);
    } catch (e) {
      threw = e;
    }
    check(`${locale}: a consent-only update_worker RENDERS rather than throwing`, threw === null, String(threw));
    check(`${locale}: the granted card names the worker`, granted.includes('Zé'), granted);
    check(`${locale}: withdrawing consent renders too`, withdrawn.length > 0, withdrawn);
    check(
      `${locale}: granting and withdrawing do NOT read as the same card`,
      granted.length > 0 && withdrawn.length > 0 && granted !== withdrawn,
      `${granted} / ${withdrawn}`,
    );
    check(
      `${locale}: neither card leaks an undefined from a missing translation`,
      !/undefined/.test(granted) && !/undefined/.test(withdrawn),
      `${granted} / ${withdrawn}`,
    );
  }

  // The refusal that must SURVIVE the fix: an update naming no field at all is
  // still nothing to approve, and drawing a card for it would be worse than the
  // error. `false` is a change; absent is not.
  let emptyThrew: unknown = null;
  try {
    await card({ worker_id: workerId }, 'pt-PT');
  } catch (e) {
    emptyThrew = e;
  }
  check('an update_worker naming no field at all is still refused', emptyThrew instanceof RenderError);

  // And the Argentine 9, on the card itself. The card is the manager's last
  // chance to spot a wrong number, so it has to show the number that will
  // actually be stored, not the one the model typed.
  const argentine = await card({ worker_id: workerId, phone: '+541178876189' }, 'pt-PT');
  check(
    'a phone change renders the number as it will be STORED, with the Argentine 9',
    argentine.includes('+5491178876189'),
    argentine,
  );
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(lines.join('\n'));
console.log(`\nGuard check: ${lines.length - failures}/${lines.length} passed; failures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
