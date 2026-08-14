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
// It guards four things, and each of them fails SILENTLY in production:
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
import { getProposableTool } from '@capo/core/capabilities/propose';
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
// The fake Db answers exactly one query — the proposals insert. `create_job` is
// used because its card renders from action_args alone with no lookups
// (render.ts), so no other table has to be faked. The tool handed to runGuarded
// is the REAL create_job with only its `execute` swapped for a recorder, so the
// schema and the rendered card are the production ones and cannot drift from
// what this file asserts.
{
  const inserted: Record<string, unknown>[] = [];
  const fakeDb = {
    from(table: string) {
      if (table !== 'proposals') throw new Error(`guard-check: unexpected table ${table}`);
      return {
        insert(row: Record<string, unknown>) {
          inserted.push(row);
          return {
            select: () => ({
              single: async () => ({ data: { id: `proposal-${inserted.length}` }, error: null }),
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

  const ctxFor = (posture: 'always_ask' | 'trust_quote'): ToolContext => ({
    companyId: '11111111-1111-1111-1111-111111111111',
    conversationId: '22222222-2222-2222-2222-222222222222',
    db: fakeDb,
    actor: 'manager',
    recentUserTexts: ['cria a obra Casa do Zé'],
    userId: '33333333-3333-3333-3333-333333333333',
    confirmPosture: posture,
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
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(lines.join('\n'));
console.log(`\nGuard check: ${lines.length - failures}/${lines.length} passed; failures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
