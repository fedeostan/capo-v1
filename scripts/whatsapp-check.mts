// WhatsApp channel check — the deterministic half of the WhatsApp QA gate.
// Like `pnpm scheduler-check` (and unlike `pnpm agent-smoke`) it needs NO
// credentials, no network and no model, so it can run in CI on every PR.
//
// It guards the bugs this file was written for:
//   1. Approval cards never reached WhatsApp at all — the sink filtered the
//      assistant's parts down to `type === 'text'`, and a card is a TOOL
//      output part. The manager was told a card had appeared and got nothing.
//   2. The model writes markdown (`**bold**`); WhatsApp bold is a SINGLE
//      asterisk, so every emphasis rendered as literal asterisks.
//   3. Meta rejects an interactive message whose button title exceeds 20 chars
//      or whose body exceeds 1024 — a runtime 400 with no build-time signal.
//   4. A template quick-reply payload has far less room than an interactive
//      reply id's 256 chars, and a truncated payload does not fail loudly — it
//      comes back unparseable and the worker's tap disappears.
//   5. A template body parameter containing a newline, a tab or a run of 4+
//      spaces is rejected wholesale with Meta's 132000, and the natural way to
//      render a task list is one per line.
//   6. Sender resolution must prefer the PHONE over the BSUID. Inverting that
//      preference would silently route every known manager through a second,
//      weaker key, and nothing else in this repo would notice.
//   7. A BSUID recipient goes in Meta's `recipient` field, never in `to`.
//      Sending both is legal and `to` wins — so the wrong shape does not fail,
//      it delivers to a stale phone number and reports success.
//   8. A `user_id_update` webhook change carries NO messages array, so the old
//      parser dropped every BSUID rotation without a trace. That is the one
//      defect here with no symptom at all: a stored id quietly stops pointing
//      at anybody, months after the change.
//   9. A worker turn can never produce an approval card — the worker roster has
//      no way to build one — so if one ever appears, the isolation between the
//      two rosters has broken. planWorkerMessages must THROW on that rather
//      than skip it: a dropped card is defect 1 again, and on the worker path
//      it would be the only signal we would ever get.
//  10. Every briefing went out as a PAID template, including to people already
//      inside their free 24-hour window (issue #46). The predicate that fixes
//      that has to fail CLOSED: guessing "inside" earns a 131047 and the
//      recipient gets NOTHING, which on the 07:00 send is a silent morning for
//      the whole crew. Guessing "outside" only costs money. Every ambiguity —
//      null, garbage, a future timestamp — must resolve to the template.
//  11. The manager could be reading a WhatsApp conversation Capo had no record
//      of (issue #47). The three chat-thread notes are what close that, and
//      what may be IN them is a safety boundary rather than a style question:
//      our own copy, counts, manager-authored crew names and a two-valued
//      button — never a word a crew member typed. The other half of that
//      boundary is asserted by `pnpm guard-check`.
//  12. WhatsApp gave the manager NO sign anything was happening (issue #50) —
//      no ticks, no "typing", nothing, for the ten to thirty seconds a turn
//      takes. The fix adds outbound traffic to the one channel where extra
//      traffic can cost real money, so what is pinned here is the SHAPE that
//      keeps it free: a read receipt / typing indicator carries no `type` and
//      no `template`, so it cannot be billed as one, and no `to`/`recipient`,
//      so it cannot be addressed at a stale number either.
//
// Run with `pnpm whatsapp-check`. Exit 0 = green, 1 = at least one failure.

import type { UIMessage } from 'ai';
import {
  buildListPayload,
  buildReceiptBody,
  buildSendBody,
  buildTemplatePayload,
  listFits,
  checkinPayload,
  mayNarrateProgress,
  PROGRESS_NOTE_AFTER_MS,
  TYPING_INDICATOR_MS,
  hasWhatsAppConsent,
  isBsuid,
  isOutsideWindowError,
  FREE_FORM_WINDOW_MS,
  OUTSIDE_WINDOW_ERROR_CODE,
  parseCheckinPayload,
  parseProposalButtonId,
  parseWorkerMenuRowId,
  planAssistantMessages,
  planWorkerMessages,
  proposalButtonId,
  readSender,
  routeWebhookChanges,
  senderLabel,
  splitForWhatsApp,
  toTemplateParam,
  toWhatsAppMarkdown,
  workerMenuRowId,
  WhatsAppSendError,
  withinFreeFormWindow,
  type ApprovalLabels,
} from '@capo/core/channels/whatsapp';
import { getCatalog } from '@capo/i18n/catalog';
import { LOCALES } from '@capo/i18n/locale';
import { allTemplates, MANAGED_TEMPLATE_NAMES, TEMPLATE_LANGUAGES } from './whatsapp-templates.ts';
// The free-form renderer lives in the web app rather than @capo/core, for the
// same reason renderWorkerBriefing does: it needs the USER copy catalog, which
// must never enter the agent bundle. Reached the same way scheduler-check
// reaches apps/web/lib/cron — it is pure, so no credentials come with it.
import {
  loadCompanyBriefing,
  renderCheckinAnswerEvent,
  renderCheckinEvent,
  renderManagerEvent,
  renderWorkerBriefing,
  renderWorkerFreeForm,
  type BriefingTask,
  type WorkerBriefing,
} from '../apps/web/app/notifications/briefing.ts';
// The GUIDED MENU (issue #49). Pure renderers over the same rows the briefing
// reads, reached the same way — no Db, no clock, no network.
import {
  buildWorkerMenu,
  renderTaskDetail,
} from '../apps/web/app/notifications/worker-menu.ts';
// The three keyword tables that sit IN FRONT of the worker agent. They moved
// out of the Next route precisely so this file could assert them: three sets
// that must stay pairwise disjoint cannot be checked by reading.
import {
  LANGUAGE_KEYWORDS,
  MENU_KEYWORDS,
  OPT_IN_KEYWORDS,
  OPT_OUT_KEYWORDS,
  consentCommand,
  languageCommand,
  menuCommand,
} from '../apps/web/lib/worker-keywords.ts';
// The pure half of "a worker tapped Sim, terminei" (issue #54). Same reasoning
// as the briefing import above: no Db, no clock, no network.
import {
  checkinDoneAck,
  classifyClaimError,
  readTaskIds,
} from '../apps/web/lib/checkin-claim.ts';
// The one-shot progress-note timer (issue #50). Not pure — it schedules — but
// it needs no credentials, no network and no model, and it is the riskiest new
// code in that change: a timer that leaked past its request, or a feedback
// failure that took the real answer down with it, would both be invisible
// everywhere else. Exercised below with millisecond delays.
import { withProgressNote } from '../apps/web/lib/whatsapp-feedback.ts';
import { buildWhatsAppLink } from '../apps/web/lib/whatsapp-handshake.ts';
import type { Db } from '@capo/db/client';

let failures = 0;
const lines: string[] = [];

function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures += 1;
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function eq(name: string, actual: unknown, expected: unknown) {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

/**
 * A `Db` that answers every `.from(table).select(…).eq(…)…` chain with a fixed
 * array. Enough for loadCompanyBriefing, which reads exactly two relations and
 * filters both entirely in SQL. Anything not seeded comes back empty, which is
 * what makes `task_board` optional here — the exclusion counters do not depend
 * on who has tasks.
 *
 * The chain object is its own thenable so `Promise.all([...])` can await the
 * builders directly, which is how the real supabase-js client behaves.
 */
function fakeBriefingDb(rows: Record<string, unknown[]>): Db {
  const from = (table: string) => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      then: (resolve: (value: { data: unknown[]; error: null }) => unknown) =>
        resolve({ data: rows[table] ?? [], error: null }),
    };
    return chain;
  };
  return { from } as unknown as Db;
}

// ── markdown conversion ─────────────────────────────────────────────────────
const md: [name: string, input: string, expected: string][] = [
  ['bold loses the doubled asterisk', '**Casa de Paco**', '*Casa de Paco*'],
  ['two bold spans on one line', '**a** e **b**', '*a* e *b*'],
  ['bold-italic becomes nested markers', '***a***', '*_a_*'],
  ['underscore bold-italic', '___a___', '*_a_*'],
  ['underscore bold', '__a__', '*a*'],
  ['single underscores are left alone', '_a_', '_a_'],
  ['snake_case survives (documented non-goal)', 'campo start_date', 'campo start_date'],
  ['h1 becomes bold', '# Plano', '*Plano*'],
  ['heading with inner bold stays balanced', '### **Prazo**', '*Prazo*'],
  ['links are flattened', '[Capo](https://capo.pt)', 'Capo (https://capo.pt)'],
  ['a self-titled link keeps only the url', '[https://x.pt](https://x.pt)', 'https://x.pt'],
  ['images keep their alt text', '![obra](https://x.pt/a.png)', 'obra (https://x.pt/a.png)'],
  ['asterisk bullets become dashes', '* uma\n* duas', '- uma\n- duas'],
  ['plus bullets become dashes', '+ uma', '- uma'],
  ['dash bullets are already native', '- uma\n- duas', '- uma\n- duas'],
  ['numbered lists are already native', '1. uma\n2. duas', '1. uma\n2. duas'],
  ['block quotes are already native', '> atenção', '> atenção'],
  ['horizontal rules are dropped', 'a\n\n---\n\nb', 'a\n\nb'],
  // The trap the [^\n] emphasis patterns exist to prevent: a greedy [\s\S]
  // pattern would pair the two line-leading asterisks into one bold span.
  ['a bullet list is never eaten as one bold span', '* a\n* b\n* c', '- a\n- b\n- c'],
  ['a fenced block is byte-identical', 'x\n\n```\n**nao** _tocar_\n```', 'x\n\n```\n**nao** _tocar_\n```'],
  ['inline code is byte-identical', 'usa `**isto**` assim', 'usa `**isto**` assim'],
];

for (const [name, input, expected] of md) {
  eq(name, toWhatsAppMarkdown(input), expected);
}

// Idempotence: the sink must be safe to run over already-converted text.
check(
  'conversion is idempotent over every fixture',
  md.every(([, input]) => toWhatsAppMarkdown(toWhatsAppMarkdown(input)) === toWhatsAppMarkdown(input)),
  md.filter(([, i]) => toWhatsAppMarkdown(toWhatsAppMarkdown(i)) !== toWhatsAppMarkdown(i))
    .map(([n]) => n)
    .join(', '),
);

// A realistic Capo paragraph, end to end.
eq(
  'a realistic reply converts whole',
  toWhatsAppMarkdown('Listo, jefe. Obra creada: **Casa de Paco**.\n\n* cocina\n* baño\n\nVer [el plan](https://capo.pt/p/1).'),
  'Listo, jefe. Obra creada: *Casa de Paco*.\n\n- cocina\n- baño\n\nVer el plan (https://capo.pt/p/1).',
);

// ── splitting ───────────────────────────────────────────────────────────────
const long = Array.from({ length: 300 }, (_, i) => `parágrafo ${i} ${'x'.repeat(30)}`).join('\n\n');
const chunks = splitForWhatsApp(long);
check('a 9k-char body is split', chunks.length > 1, `${long.length} chars → ${chunks.length} chunks`);
check(
  'every chunk fits WhatsApp\'s text limit',
  chunks.every(c => c.length <= 4000),
  chunks.map(c => c.length).join(', '),
);
check(
  'splitting loses no content',
  chunks.join('').replace(/\s/g, '') === long.replace(/\s/g, ''),
);
eq('a short body is a single chunk', splitForWhatsApp('curto').length, 1);

// ── button id codec ─────────────────────────────────────────────────────────
const uuid = '3f1a9c02-5b7d-4e88-9a10-2c6d4f8b1e33';
const approveId = proposalButtonId('approve', uuid);
eq('button ids round-trip (decision)', parseProposalButtonId(approveId)?.decision, 'approve');
eq('button ids round-trip (proposal)', parseProposalButtonId(approveId)?.proposalId, uuid);
check('a minted id fits Meta\'s 256-char cap', approveId.length <= 256, `${approveId.length} chars`);
// A malformed uuid must be rejected HERE: it would otherwise reach a .eq() on
// a uuid column and surface as a Postgres 22P02 instead of "not ours".
eq('a malformed uuid is rejected', parseProposalButtonId('capo:approve:not-a-uuid'), null);
eq('a foreign prefix is rejected', parseProposalButtonId(`evil:approve:${uuid}`), null);
eq('an unknown decision is rejected', parseProposalButtonId(`capo:delete:${uuid}`), null);
eq('an empty id is rejected', parseProposalButtonId(''), null);
eq(
  'approve and reject ids differ',
  proposalButtonId('approve', uuid) === proposalButtonId('reject', uuid),
  false,
);

// ── check-in payload codec ──────────────────────────────────────────────────
const doneP = checkinPayload('done', uuid);
const notDoneP = checkinPayload('not_done', uuid);
eq('check-in payloads round-trip (answer)', parseCheckinPayload(doneP)?.answer, 'done');
eq('check-in payloads round-trip (notification)', parseCheckinPayload(doneP)?.notificationId, uuid);
eq('the not_done answer round-trips too', parseCheckinPayload(notDoneP)?.answer, 'not_done');
// 128 is the cap sendWhatsAppTemplate THROWS on. If a minted payload ever
// exceeded it, every check-in send would fail at once — assert it can't.
check('a minted payload fits the 128-char cap', doneP.length <= 128, `${doneP.length} chars`);
check('the longer answer also fits', notDoneP.length <= 128, `${notDoneP.length} chars`);
eq('a malformed uuid is rejected', parseCheckinPayload('capo:checkin:done:not-a-uuid'), null);
eq('an unknown answer is rejected', parseCheckinPayload(`capo:checkin:maybe:${uuid}`), null);
eq('a foreign prefix is rejected', parseCheckinPayload(`evil:checkin:done:${uuid}`), null);
eq('an empty payload is rejected', parseCheckinPayload(''), null);
// THE failure mode this codec exists to make visible: if the template declares
// quick replies but the send omits the button component, Meta returns 200 and
// echoes the button's LABEL as the payload. It must parse as null, not as an
// answer.
eq('a bare button label is rejected', parseCheckinPayload('Sim, terminei'), null);
eq('done and not_done payloads differ', doneP === notDoneP, false);
// Cross-parse isolation. Two different button shapes arrive on the same
// webhook; neither parser may ever accept the other's value, or a manager's
// approval could be recorded as a worker's check-in.
eq('a proposal id is not a check-in payload', parseCheckinPayload(approveId), null);
eq('a check-in payload is not a proposal id', parseProposalButtonId(doneP), null);

// ── the completion claim behind a "done" tap (issue #54) ────────────────────
// The tap now files open_task_review per task instead of recording an answer
// and stopping. The RPC itself cannot be reached without a database, so these
// pin the two pure decisions in front of it: which errors are ordinary and
// which are real, and which sentence the worker gets back.
{
  // task_ids is typed `Json`, i.e. unknown, and every id goes straight into a
  // uuid argument. A malformed snapshot must claim nothing, never throw.
  eq('a null task_ids snapshot yields no ids', readTaskIds(null).length, 0);
  eq('a non-array task_ids snapshot yields no ids', readTaskIds('nope').length, 0);
  eq('non-string members are dropped', readTaskIds([uuid, 7, null, '']).length, 1);
  eq('duplicate ids are collapsed', readTaskIds([uuid, uuid]).length, 1);

  // The three SQLSTATEs 0018/0019 raise on purpose. Misreading any of them as a
  // hard failure sends a worker to find their foreman for nothing; misreading a
  // real failure as ordinary tells them the manager was notified when nobody was.
  eq('no error means the claim was filed', classifyClaimError(null), 'claimed');
  eq(
    'the one-pending unique violation is ordinary',
    classifyClaimError({ code: '23505', message: 'duplicate key value violates unique constraint "task_reviews_one_pending_idx"' }),
    'already_pending',
  );
  eq(
    'a lost SQLSTATE still reads as already pending',
    classifyClaimError({ code: '', message: 'task_reviews_one_pending_idx' }),
    'already_pending',
  );
  eq(
    "0019's done/cancelled guard is ordinary",
    classifyClaimError({ code: '23514', message: 'task abc is done, not open' }),
    'closed',
  );
  eq(
    'a vanished task is its own outcome',
    classifyClaimError({ code: '02000', message: 'task abc not found' }),
    'missing',
  );
  // Unreachable on this path — auth.uid() is null for the service role, so
  // open_task_review's tenant guard never fires — which is exactly why it must
  // NOT be swallowed as ordinary if it ever shows up.
  eq(
    'a tenant-guard refusal is a real failure',
    classifyClaimError({ code: '42501', message: 'task abc is not yours' }),
    'failed',
  );
  eq('an unknown error is a real failure', classifyClaimError({ code: '08006', message: 'connection lost' }), 'failed');

  // The acknowledgement. NONE of the three says "done"; that is the whole bug.
  eq('one claim means the manager has it', checkinDoneAck(['claimed']), 'awaiting');
  eq('an already-pending claim is the same end state', checkinDoneAck(['already_pending']), 'awaiting');
  // The case the per-task loop exists for: three tasks, one closed at lunch,
  // one already claimed, one newly claimed. The worker hears the useful fact.
  eq('a partial success still reports awaiting', checkinDoneAck(['closed', 'already_pending', 'claimed']), 'awaiting');
  eq('a failure alongside a claim does not drown it', checkinDoneAck(['failed', 'claimed']), 'awaiting');
  eq('every task already closed is not an error', checkinDoneAck(['closed', 'closed']), 'nothing');
  eq('an empty snapshot is not an error', checkinDoneAck([]), 'nothing');
  eq('a failure with nothing claimed is an error', checkinDoneAck(['failed']), 'error');
  eq('a vanished task with nothing claimed is an error', checkinDoneAck(['missing', 'closed']), 'error');

  // The copy itself. Every locale must have all three, and none of them may be
  // the superseded checkinDone — a worker told "done" who sees the same task on
  // tomorrow's 07:00 briefing concludes Capo is broken.
  for (const locale of LOCALES) {
    const t = getCatalog(locale).whatsapp;
    check(`${locale}: all three done-acks are present and distinct`,
      new Set([t.checkinDoneAwaiting, t.checkinDoneNothing, t.checkinDoneProblem]).size === 3);
    check(`${locale}: the awaiting ack is not the superseded checkinDone`,
      t.checkinDoneAwaiting !== t.checkinDone);
    check(`${locale}: the awaiting ack fits one WhatsApp message`,
      t.checkinDoneAwaiting.length > 0 && t.checkinDoneAwaiting.length <= 300,
      `${t.checkinDoneAwaiting.length} chars`);
  }
}

// ── who the daily sends skip, and whether it is countable (issue #54) ───────
// An inactive crew row is skipped on purpose. Until #54 it was skipped BEFORE
// either exclusion counter could see it, so a switched-off worker appeared in
// no signal at all — which is how issue #51's "the manager got no check-in
// card" cost a log dive and a database session. These pin that the three
// reasons partition the crew rather than overlapping.
// Runs the REAL loadCompanyBriefing against a fake Db, the same device
// guard-check uses on runGuarded: a pure re-implementation of the arithmetic
// here would keep passing if somebody put the `active` filter back in the SQL.
{
  const optedIn = '2026-08-01T10:00:00Z';
  const crew = [
    // messaged: active, has a phone, opted in
    { id: 'w1', name: 'Zé', active: true, phone: '351911111111', whatsapp_opt_in_at: optedIn },
    // active and reachable, but never ticked the box
    { id: 'w2', name: 'Pepe', active: true, phone: '351922222222', whatsapp_opt_in_at: null },
    // active and consenting, but no phone and no BSUID — nowhere to send
    { id: 'w3', name: 'Ana', active: true, phone: null, whatsapp_opt_in_at: optedIn },
    // switched off. Reachable and consenting, and still skipped — correctly.
    // This is Federico's own crew row on Ostan construcciones (issue #51).
    { id: 'w4', name: 'Federico', active: false, phone: '5491178876189', whatsapp_opt_in_at: optedIn },
    // switched off AND unreachable: must be counted ONCE, as inactive.
    { id: 'w5', name: 'Antigo', active: false, phone: null, whatsapp_opt_in_at: null },
  ];

  const briefing = await loadCompanyBriefing(fakeBriefingDb({ workers: crew }), 'co', 'pt-PT');

  eq('only the messageable worker survives every gate', briefing.workers.length, 1);
  eq('and it is the one with a phone and an opt-in', briefing.workers[0]?.workerId, 'w1');
  eq('inactive crew rows are counted, not invisible', briefing.excludedInactive, 2);
  eq('an inactive worker is not ALSO counted unreachable', briefing.excludedUnreachable, 1);
  eq('the consent count is unchanged by the new one', briefing.excludedNoConsent, 1);
  eq(
    'the three exclusions plus the messaged crew account for everyone',
    briefing.excludedInactive + briefing.excludedUnreachable + briefing.excludedNoConsent + briefing.workers.length,
    crew.length,
  );
}

// ── the chat-thread notes (issue #47) ───────────────────────────────────────
// The three lines the SYSTEM writes into the manager's own conversation, so
// that what the manager sees on WhatsApp and what Capo sees in the thread are
// the same day. Before #47 the 07:00 route wrote one of them and the check-in
// route wrote nothing, so the crew could be mid-conversation with Capo about a
// question Capo had no record of asking.
//
// These are not WhatsApp messages, but they are checked here because they are
// rendered from the SAME briefing module and describe the same two sends — and
// because the only thing standing between them and a real privilege escalation
// is what is allowed to be in them. See guard-check for the other half: an
// event row must never become guard evidence.
{
  const counts = { today: 3, unassigned: 1, overdue: 2 };
  const crew = ['Zé', 'Ana', 'Miguel'];

  for (const locale of LOCALES) {
    const morning = renderManagerEvent(counts, crew.length, crew, locale);
    check(`${locale}: the morning note NAMES who was briefed`,
      crew.every(name => morning.includes(name)), morning);
    check(`${locale}: and still carries the day's counts`, morning.includes('3') && morning.includes('2'), morning);

    const ask = renderCheckinEvent(crew.length, crew, locale);
    check(`${locale}: the check-in note names who was asked`,
      crew.every(name => ask.includes(name)), ask);

    const done = renderCheckinAnswerEvent({ name: 'Zé', answer: 'done', tasks: 2 }, locale);
    const notDone = renderCheckinAnswerEvent({ name: 'Zé', answer: 'not_done', tasks: 2 }, locale);
    check(`${locale}: the two answers read differently`, done !== notDone, `${done} / ${notDone}`);
    check(`${locale}: both name the crew member who answered`,
      done.includes('Zé') && notDone.includes('Zé'));
    // A tap is a CLAIM, never a completion — task_board.is_open is a denylist,
    // so the task stays open. A note telling the manager the work is done would
    // put the thread back in disagreement with the board, which is the exact
    // shape of the bug #54 fixed on the worker's own acknowledgement. Checked
    // by length because the sentence itself is per-language: the "done" note
    // must carry a whole extra clause about waiting, not merely a different verb.
    check(`${locale}: the "done" note carries an extra "waiting on you" clause`,
      done.length > notDone.length + 25, `${done.length} vs ${notDone.length}`);
  }

  // Nobody messaged: the note must still be a sentence, not a dangling colon.
  // Reachable in two different ways — a company whose whole crew lacks consent,
  // and an evening where every send failed after the claims were won — so both
  // renderers need the branch.
  for (const locale of LOCALES) {
    const silent = renderManagerEvent(counts, 0, [], locale);
    check(`${locale}: a morning where nobody was messaged still reads as a sentence`,
      silent.length > 0 && !silent.includes(': .') && !silent.trimEnd().endsWith(':'), silent);

    const noAsk = renderCheckinEvent(0, [], locale);
    check(`${locale}: an evening where nobody was asked still reads as a sentence`,
      noAsk.length > 0 && !noAsk.trimEnd().endsWith(':') && !noAsk.includes(' 0 '), noAsk);
  }

  // A crew of thirty must not put thirty names in the manager's thread AND in
  // the model's context every single morning, where the summarizer then merges
  // it forward indefinitely.
  const big = Array.from({ length: 30 }, (_, i) => `Trabalhador ${i + 1}`);
  const capped = renderManagerEvent(counts, big.length, big, 'pt-PT');
  check('a 30-person crew is capped, not listed in full',
    !capped.includes('Trabalhador 30') && capped.includes('+22'), capped);
  check('and the count still tells the truth about how many were messaged',
    capped.includes('30'), capped);

  // Names are manager-authored free text. A pasted newline would otherwise
  // break the one-line shape these notes are read in.
  const messy = renderManagerEvent(counts, 1, ['Zé\n  Silva'], 'pt-PT');
  check('a name with a newline in it is flattened', !messy.includes('\n'), JSON.stringify(messy));

  // An unreadable task_ids snapshot yields zero ids (readTaskIds above). The
  // note must still be a sentence rather than "(0 tarefas)".
  const zero = renderCheckinAnswerEvent({ name: 'Ana', answer: 'done', tasks: 0 }, 'pt-PT');
  check('an empty task snapshot does not print a zero count', !zero.includes('0 '), zero);
}

// ── bsuid ───────────────────────────────────────────────────────────────────
// isBsuid is the TS half of a rule enforced twice — the other half is the CHECK
// constraint in supabase/migrations/0022_whatsapp_bsuid.sql. Nothing keeps the
// two regexes in step automatically, so these assertions are also the record of
// what the constraint is supposed to say.
const bsuid = 'PT.13491208655302741918';
check('a real BSUID is accepted', isBsuid(bsuid));
check('a one-character tail is accepted', isBsuid('US.1'));
check('a 128-character tail is the limit', isBsuid(`US.${'x'.repeat(128)}`));
// THE rejection that matters. A parent BSUID is issued to a multi-portfolio
// business; Capo is a single portfolio, so one stored here would look like an
// identity while belonging to nobody in particular. The single dot is what
// refuses it — this is the assertion that catches a "helpful" regex loosening.
eq('a PARENT BSUID is rejected', isBsuid('US.ENT.11815799212886844830'), false);
eq('a phone number is not a BSUID', isBsuid('+351912345678'), false);
eq('a bare wa_id is not a BSUID', isBsuid('351912345678'), false);
eq('an empty string is rejected', isBsuid(''), false);
eq('a missing tail is rejected', isBsuid('PT.'), false);
eq('a missing dot is rejected', isBsuid('PT13491208655302741918'), false);
eq('a lowercase country code is rejected', isBsuid('pt.13491208655302741918'), false);
eq('a one-letter country code is rejected', isBsuid('P.123'), false);
eq('a 129-character tail is rejected', isBsuid(`US.${'x'.repeat(129)}`), false);
// Anchoring, both ends. An unanchored pattern would accept a BSUID with junk
// welded on and hand the DB something its CHECK constraint then rejects.
eq('a trailing newline is rejected', isBsuid(`${bsuid}\n`), false);
eq('a leading space is rejected', isBsuid(` ${bsuid}`), false);
eq('an embedded BSUID is rejected', isBsuid(`x${bsuid}x`), false);

// senderLabel runs inside after() callbacks, where a throw is an unhandled
// rejection that bypasses the very logEvent it was reaching for. All three
// shapes must produce a value, and none may leak a whole identifier.
eq('a phone sender is labelled by its last four', senderLabel({ from: '351912345678' }), '…5678');
eq('a BSUID-only sender is labelled and marked', senderLabel({ from_user_id: bsuid }), 'id:…1918');
eq('neither identifier is still a label', senderLabel({}), 'unknown');
eq('the phone wins when both are present', senderLabel({ from: '351912345678', from_user_id: bsuid }), '…5678');
check(
  'no label contains a whole identifier',
  [senderLabel({ from: '351912345678' }), senderLabel({ from_user_id: bsuid }), senderLabel({})].every(
    label => !label.includes('351912345678') && !label.includes(bsuid),
  ),
);
// The two shapes must be distinguishable in a log drain, or triage cannot tell
// "we do not know this number" from "this person has a username now".
check(
  'a phone label and a BSUID label are distinguishable',
  senderLabel({ from: '351911111918' }) !== senderLabel({ from_user_id: bsuid }),
);

// ── sender resolution: which identifier wins ────────────────────────────────
// THE safety property of the whole BSUID change. Phone-first is what guarantees
// today's payloads take today's path; if this preference ever inverted, every
// message from someone we know by phone would start being resolved against a
// second, weaker key, and nothing else in the repo would notice.
const waId = '351912345678';
eq('a phone-only sender is answered on the phone', readSender({ from: waId })?.replyTo.kind, 'phone');
eq('and carries no BSUID', readSender({ from: waId })?.bsuid, undefined);
eq(
  'a BSUID-only sender is answered on the BSUID',
  readSender({ from_user_id: bsuid })?.replyTo.kind,
  'bsuid',
);
eq('and has no phone to fall back to', readSender({ from_user_id: bsuid })?.from, undefined);
const bothIds = readSender({ from: waId, from_user_id: bsuid });
eq('WITH BOTH PRESENT, THE PHONE WINS', bothIds?.replyTo.kind, 'phone');
eq('and the reply goes to that exact wa_id', bothIds?.replyTo.kind === 'phone' ? bothIds.replyTo.waId : null, waId);
// Still carried, because captureBsuid needs it: the 30-day overlap in which
// both identifiers arrive together is the only chance to bind them.
eq('but the BSUID is still carried, for capture', bothIds?.bsuid, bsuid);
eq('neither identifier yields no sender at all', readSender({}), null);
// A parent BSUID must never become a lookup key — it belongs to a portfolio,
// not a person. isBsuid rejects it, and readSender is where that takes effect.
eq(
  'a parent BSUID alone is not a usable sender',
  readSender({ from_user_id: 'US.ENT.11815799212886844830' }),
  null,
);
eq(
  'and it never shadows a perfectly good phone',
  readSender({ from: waId, from_user_id: 'US.ENT.11815799212886844830' })?.bsuid,
  undefined,
);
eq('a malformed BSUID is treated as absent', readSender({ from_user_id: 'not-an-id' }), null);

// ── outbound addressing: `to` XOR `recipient` ───────────────────────────────
// Meta will not accept a BSUID in `to`, and if BOTH fields are sent it silently
// prefers `to`. That silent precedence is the failure this asserts against: a
// BSUID send that quietly went to a stale phone number looks like a success in
// every log we keep.
const message = { type: 'text', text: { body: 'olá' } };
const phoneBody = buildSendBody(message, { kind: 'phone', waId });
const bsuidBody = buildSendBody(message, { kind: 'bsuid', userId: bsuid });
eq('a phone recipient is addressed in `to`', phoneBody.to, waId);
eq('and emits no `recipient`', 'recipient' in phoneBody, false);
eq('a BSUID recipient is addressed in `recipient`', bsuidBody.recipient, bsuid);
eq('and emits no `to`', 'to' in bsuidBody, false);
check(
  'exactly one addressing field on every body',
  [phoneBody, bsuidBody].every(b => Number('to' in b) + Number('recipient' in b) === 1),
);
check(
  'messaging_product survives both branches',
  [phoneBody, bsuidBody].every(b => b.messaging_product === 'whatsapp'),
);
check(
  'and so does the message payload itself',
  [phoneBody, bsuidBody].every(b => b.type === 'text'),
);

// ── the webhook change router ───────────────────────────────────────────────
// Before this existed the route flat-mapped `change.value.messages` and ignored
// `change.field`, so a user_id_update — a change with no messages array at all —
// was dropped without a trace. These fixtures are the record of what each field
// is supposed to produce.
interface Fixture {
  id: string;
}
function changes(...list: unknown[]) {
  return { entry: [{ changes: list as never[] }] };
}

const onlyMessages = routeWebhookChanges<Fixture>(
  changes({ field: 'messages', value: { messages: [{ id: 'wamid.1' }, { id: 'wamid.2' }] } }),
);
eq('a messages change yields its messages', onlyMessages.messages.length, 2);
eq('and no rotations', onlyMessages.rotations.length, 0);
eq('and nothing unhandled', onlyMessages.unhandledFields.length, 0);
eq('message objects pass through untouched', onlyMessages.messages[0]?.id, 'wamid.1');

// The compatibility branch. Meta always sets `field`, but the route this
// replaces never read it — so any payload that worked before must still work,
// including a test harness that omits it. Dispatching on the field alone would
// silently drop real messages, the one regression this change must not have.
const fieldless = routeWebhookChanges<Fixture>(changes({ value: { messages: [{ id: 'wamid.3' }] } }));
eq('a field-less change still yields its messages', fieldless.messages.length, 1);
eq('and is not reported as unhandled', fieldless.unhandledFields.length, 0);

const rotated = routeWebhookChanges<Fixture>(
  changes({
    field: 'user_id_update',
    value: {
      user_id_update: [
        {
          wa_id: waId,
          user_id: { previous: 'PT.111', current: 'PT.222' },
          // Present on the wire for multi-portfolio businesses; we are one
          // portfolio, so it must be parsed and DROPPED, never carried forward.
          parent_user_id: 'US.ENT.11815799212886844830',
        },
      ],
    },
  }),
);
eq('a rotation yields ZERO messages', rotated.messages.length, 0);
eq('and one rotation', rotated.rotations.length, 1);
eq('the old id', rotated.rotations[0]?.previous, 'PT.111');
eq('the new id', rotated.rotations[0]?.current, 'PT.222');
eq('the phone is carried for logs only', rotated.rotations[0]?.waId, waId);
eq(
  'the parent BSUID is dropped, not carried',
  Object.keys(rotated.rotations[0] ?? {}).sort().join(','),
  'current,previous,waId',
);
eq('a rotation is never reported as an unhandled field', rotated.unhandledFields.length, 0);

// The payload shape is documented only in Meta's changelog and quoted verbatim
// by no public source, so an entry we cannot read must be COUNTED rather than
// dropped — otherwise a shape surprise is indistinguishable from no rotations.
const unreadable = routeWebhookChanges<Fixture>(
  changes({
    field: 'user_id_update',
    value: { user_id_update: [{ user_id: { current: 'PT.222' } }, { nonsense: true }, null] },
  }),
);
eq('an entry missing `previous` is not a rotation', unreadable.rotations.length, 0);
eq('and all three are counted as unreadable', unreadable.unreadableRotations, 3);

const unknownField = routeWebhookChanges<Fixture>(
  changes({ field: 'message_template_status_update', value: {} }),
);
eq('an unknown field yields no messages', unknownField.messages.length, 0);
eq('and no rotations', unknownField.rotations.length, 0);
eq('and is named once, so it is discoverable', unknownField.unhandledFields.join(','), 'message_template_status_update');

// A batch really can mix all three, and the router must not let one spoil the
// others — a rotation arriving beside a manager's question cannot cost them
// their reply.
const mixed = routeWebhookChanges<Fixture>(
  changes(
    { field: 'messages', value: { messages: [{ id: 'wamid.4' }] } },
    { field: 'user_id_update', value: { user_id_update: [{ user_id: { previous: 'PT.1', current: 'PT.2' } }] } },
    { field: 'statuses', value: {} },
  ),
);
eq('a mixed batch keeps its message', mixed.messages.length, 1);
eq('its rotation', mixed.rotations.length, 1);
eq('and its unknown field', mixed.unhandledFields.join(','), 'statuses');

// Nothing about an empty or malformed envelope may throw: this runs before the
// 200 that stops Meta retrying, so a throw here becomes a redelivery storm.
const empty = routeWebhookChanges<Fixture>({});
eq('an empty body yields no messages', empty.messages.length, 0);
eq('no rotations', empty.rotations.length, 0);
eq('and nothing unhandled', empty.unhandledFields.length, 0);
const noField = routeWebhookChanges<Fixture>(changes({ value: {} }));
eq('a change with neither field nor messages is reported, not dropped', noField.unhandledFields.join(','), '(missing)');

// ── template parameters ─────────────────────────────────────────────────────
// toTemplateParam is the single easiest way to earn a 132000 and was asserted
// nowhere before.
eq('a newline is flattened', toTemplateParam('a\nb'), 'a b');
eq('a tab is flattened', toTemplateParam('a\tb'), 'a b');
eq('a run of spaces collapses', toTemplateParam('a    b'), 'a b');
eq('surrounding whitespace is trimmed', toTemplateParam('  a  '), 'a');
eq('already-flat text is untouched', toTemplateParam('Pintar paredes (Casa de Paco)'), 'Pintar paredes (Casa de Paco)');
eq("the briefing's own separator survives", toTemplateParam('a · b'), 'a · b');
const longParam = toTemplateParam('x'.repeat(2000));
eq('an over-long parameter is cut to 900', longParam.length, 900);
check('and is marked as truncated', longParam.endsWith('…'), JSON.stringify(longParam.slice(-3)));

// ── template payload shape ──────────────────────────────────────────────────
// The backward-compatibility guard: capo_daily_briefing passes no quickReplies
// and must produce exactly what it always did.
const plain = buildTemplatePayload({ name: 'capo_daily_briefing', languageCode: 'pt_PT', bodyParams: ['Miguel', 'Hoje: nada'] });
const plainComponents = (plain.template as { components: Record<string, unknown>[] }).components;
eq('a button-less template sends one component', plainComponents.length, 1);
eq('and it is the body', plainComponents[0].type, 'body');

const withButtons = buildTemplatePayload({
  name: 'capo_task_checkin',
  languageCode: 'pt_PT',
  bodyParams: ['Miguel', 'Pintar paredes'],
  quickReplies: [{ payload: doneP }, { payload: notDoneP }],
});
const btnComponents = (withButtons.template as { components: Record<string, unknown>[] }).components;
eq('two quick replies add two components', btnComponents.length, 3);
eq('the button component type', btnComponents[1].type, 'button');
eq('the button sub_type', btnComponents[1].sub_type, 'quick_reply');
// A STRING index. Meta accepts a number in some versions and rejects it in
// others, so the type is pinned, not just the value.
eq('the first index is the string "0"', btnComponents[1].index, '0');
eq('and it really is a string', typeof btnComponents[1].index, 'string');
eq('the second index is "1"', btnComponents[2].index, '1');
const firstParam = (btnComponents[1].parameters as { type: string; payload: string }[])[0];
eq('the parameter type is payload', firstParam.type, 'payload');
// The ORDER CONTRACT: index 0 must carry 'done'. Swapping these inverts every
// answer and Meta still returns 200, so nothing else would ever catch it.
eq('index 0 carries the done payload', firstParam.payload, doneP);
eq(
  'index 1 carries the not_done payload',
  (btnComponents[2].parameters as { payload: string }[])[0].payload,
  notDoneP,
);
let threw = false;
try {
  buildTemplatePayload({ name: 'x', languageCode: 'pt_PT', bodyParams: [], quickReplies: [{ payload: 'y'.repeat(200) }] });
} catch {
  threw = true;
}
check('an over-long payload throws rather than truncating', threw);

// ── proactive-send consent ──────────────────────────────────────────────────
// The gate on every proactive send. It has no test suite behind it and one
// wrong branch messages someone who never agreed, so the truth table is pinned
// here — this is the closest thing the repo has to a policy assertion.
const T1 = '2026-08-01T09:00:00.000Z'; // earlier
const T2 = '2026-08-09T09:00:00.000Z'; // later
check('no record at all → no consent', !hasWhatsAppConsent({}));
check('nulls → no consent', !hasWhatsAppConsent({ whatsapp_opt_in_at: null, whatsapp_opt_out_at: null }));
check('opted in, never out → consent', hasWhatsAppConsent({ whatsapp_opt_in_at: T1 }));
check('opted out after opting in → no consent', !hasWhatsAppConsent({ whatsapp_opt_in_at: T1, whatsapp_opt_out_at: T2 }));
// The case a presence-only test would get wrong, leaving anyone who ever left
// permanently unreachable even after they asked to come back.
check('opted back in after opting out → consent', hasWhatsAppConsent({ whatsapp_opt_in_at: T2, whatsapp_opt_out_at: T1 }));
check('opted out with no opt-in → no consent', !hasWhatsAppConsent({ whatsapp_opt_out_at: T1 }));
// Same instant is a tie, and a tie must not be read as consent.
check('a simultaneous pair → no consent', !hasWhatsAppConsent({ whatsapp_opt_in_at: T1, whatsapp_opt_out_at: T1 }));
// Garbage in a timestamp column must fail CLOSED, never open.
check('an unparseable opt-out → no consent', !hasWhatsAppConsent({ whatsapp_opt_in_at: T1, whatsapp_opt_out_at: 'não sei' }));
check('an unparseable opt-in → no consent', !hasWhatsAppConsent({ whatsapp_opt_in_at: 'ontem' }));

// ── the 24-hour free-form window (issue #46) ────────────────────────────────
// The predicate that decides whether a briefing costs money. It is the same
// class of thing as hasWhatsAppConsent above — one wrong branch and the
// consequence is invisible — so the truth table is pinned here too.
//
// It must return true ONLY on positive proof. Everything else sends a template:
// a template always arrives, whereas free-form text outside the window is
// refused with 131047 and the person receives nothing at all.
{
  const NOW = Date.parse('2026-08-14T07:00:00.000Z');
  const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();
  const HOUR = 60 * 60 * 1000;

  eq('23 hours is the window, not 24', FREE_FORM_WINDOW_MS, 23 * HOUR);

  check('a message a minute ago is inside', withinFreeFormWindow(at(60_000), NOW));
  check('a message 22 hours ago is inside', withinFreeFormWindow(at(22 * HOUR), NOW));
  check('a message 25 hours ago is outside', !withinFreeFormWindow(at(25 * HOUR), NOW));
  // The hour of deliberate margin. Meta's window is 24h; we stop at 23 so a
  // send decided at the top of a run cannot expire before it is posted.
  check(
    'THE MARGIN: 23.5 hours is outside, even though Meta would still allow it',
    !withinFreeFormWindow(at(23.5 * HOUR), NOW),
  );

  // Exactly at the boundary, both sides of it. An off-by-one here is a send
  // that Meta refuses and nobody ever sees.
  check('exactly at the margin is inside', withinFreeFormWindow(at(FREE_FORM_WINDOW_MS), NOW));
  check('one millisecond past it is outside', !withinFreeFormWindow(at(FREE_FORM_WINDOW_MS + 1), NOW));
  check('one millisecond inside it is inside', withinFreeFormWindow(at(FREE_FORM_WINDOW_MS - 1), NOW));
  check('this instant is inside', withinFreeFormWindow(at(0), NOW));

  // Every ambiguity resolves to the template.
  check('null → template', !withinFreeFormWindow(null, NOW));
  check('undefined (the column does not exist yet) → template', !withinFreeFormWindow(undefined, NOW));
  check('an empty string → template', !withinFreeFormWindow('', NOW));
  check('an unparseable timestamp → template', !withinFreeFormWindow('ontem de manhã', NOW));
  check('a date-shaped non-date → template', !withinFreeFormWindow('2026-13-45T99:00:00Z', NOW));
  // A FUTURE timestamp means the runtime clock and whatever wrote the column
  // disagree. That is exactly the situation in which "trust it, it's recent"
  // is the wrong instinct: we cannot tell how far off the other clock is, so we
  // cannot tell how much of the window is left.
  check('a timestamp one hour in the FUTURE → template', !withinFreeFormWindow(at(-HOUR), NOW));
  check('a timestamp one second in the future → template', !withinFreeFormWindow(at(-1000), NOW));
  check('a wildly future timestamp → template', !withinFreeFormWindow('2099-01-01T00:00:00Z', NOW));
}

// ── working-on-it feedback (issue #50) ──────────────────────────────────────
// A manager on WhatsApp sent a message and watched nothing happen. The web chat
// has "Capo está a escrever…" and a chip per tool call; WhatsApp had silence,
// which reads as "it broke".
//
// The fix is a read receipt plus a typing indicator, and — for a turn that
// outlasts the indicator — one plain-text note. THE RISK IS NOT THAT IT LOOKS
// WRONG, IT IS THAT IT COSTS MONEY: Meta bills template messages, and a status
// update that acquired a `type` or a `template` would become one silently.
// These checks pin the shape that makes that impossible.
//
// (Message EDITING, the obvious nicer design, does not exist in the Cloud API
// at all — there is one messages endpoint and it is send-only. Nothing here
// tries to edit anything, and nothing should be added that does.)
{
  const receipt = buildReceiptBody('wamid.HBgL', { typing: false });
  const typing = buildReceiptBody('wamid.HBgL', { typing: true });

  eq('a receipt is addressed by message_id', receipt.message_id, 'wamid.HBgL');
  eq('and carries messaging_product', receipt.messaging_product, 'whatsapp');
  eq('and is a status update, not a send', receipt.status, 'read');

  // THE COST GUARANTEE. A body with no `type` and no `template` cannot be
  // billed as a template message, which is the only thing Meta bills.
  check('a receipt has NO `type` — it is not a message', !('type' in receipt));
  check('a receipt has NO `template` — it can never be a paid send', !('template' in receipt));
  check('a typing indicator has NO `type` either', !('type' in typing));
  check('a typing indicator has NO `template` either', !('template' in typing));

  // THE ADDRESSING GUARANTEE. A receipt names a MESSAGE, never a recipient, so
  // it never passes through buildSendBody and the `to`-silently-wins hazard
  // that shape exists to prevent cannot reach it. A stray `to` here would also
  // be the one way a BSUID sender could be answered on a stale phone number.
  check('a receipt has NO `to`', !('to' in receipt));
  check('a receipt has NO `recipient`', !('recipient' in receipt));
  check('a typing indicator has NO `to`', !('to' in typing));
  check('a typing indicator has NO `recipient`', !('recipient' in typing));

  // The indicator RIDES the read receipt — one request, not two. There is no
  // typing-without-read shape to get wrong.
  check('typing: false emits no typing_indicator', !('typing_indicator' in receipt));
  eq('typing: true emits Meta\'s text indicator', JSON.stringify(typing.typing_indicator), '{"type":"text"}');
  eq('and still marks the message read', typing.status, 'read');

  // The note must arrive BEFORE the indicator lapses, or there is a visible
  // gap where the manager is back to staring at nothing. Reversing these two
  // constants would reintroduce exactly the silence this feature removes.
  eq('Meta dismisses the typing indicator after 25s', TYPING_INDICATOR_MS, 25_000);
  check(
    'the progress note fires BEFORE the indicator lapses',
    PROGRESS_NOTE_AFTER_MS < TYPING_INDICATOR_MS,
  );

  // The progress note is free-form text, so it is free ONLY inside the window.
  // It is triggered by an inbound message and therefore always is — but the
  // predicate is asserted rather than assumed, because the recovery path for a
  // free-form send that lands outside the window is a PAID template. Same
  // fail-closed discipline as withinFreeFormWindow above.
  const NOW = Date.parse('2026-08-14T07:00:00.000Z');
  check('a turn that started this instant may narrate', mayNarrateProgress(NOW, NOW));
  check('a turn 30 seconds in may narrate', mayNarrateProgress(NOW - 30_000, NOW));
  check('exactly at the margin may narrate', mayNarrateProgress(NOW - FREE_FORM_WINDOW_MS, NOW));
  check(
    'one millisecond past the margin may NOT',
    !mayNarrateProgress(NOW - FREE_FORM_WINDOW_MS - 1, NOW),
  );
  check('a start time in the FUTURE may not', !mayNarrateProgress(NOW + 1000, NOW));
  check('NaN may not', !mayNarrateProgress(Number.NaN, NOW));
  check('Infinity may not', !mayNarrateProgress(Number.POSITIVE_INFINITY, NOW));
}

// ── the progress-note timer itself (issue #50) ──────────────────────────────
// Real timers, millisecond delays. Four properties, each of which fails
// silently in production if it regresses:
//
//   - a fast turn sends NOTHING (otherwise every one-line answer grows a
//     pointless "still working on it" above it);
//   - a slow turn sends EXACTLY ONE note, never a heartbeat;
//   - the timer is always cleared, so nothing fires after the call returns —
//     a stray send on a frozen serverless instance is the failure the
//     no-keep-alive rule exists to prevent;
//   - a FAILED note never takes the answer down with it. Feedback that breaks
//     the reply is strictly worse than no feedback.
{
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const NOW = Date.now();

  // A turn that finishes well inside the delay.
  {
    const sent: string[] = [];
    const out = await withProgressNote(async () => { await sleep(5); return 'answer'; }, {
      inboundAt: NOW,
      send: async () => { sent.push('note'); },
      report: outcome => sent.push(`report:${outcome}`),
      delayMs: 60,
    });
    eq('a fast turn still returns its value', out, 'answer');
    eq('and sends no progress note at all', sent.length, 0);
    // If the timer had survived the call, it would fire during this wait.
    await sleep(90);
    eq('and nothing fires after it returns — the timer was cleared', sent.length, 0);
  }

  // A turn that outlasts the delay.
  {
    const sent: string[] = [];
    const out = await withProgressNote(async () => { await sleep(70); return 'answer'; }, {
      inboundAt: NOW,
      send: async () => { sent.push('note'); },
      report: outcome => sent.push(`report:${outcome}`),
      delayMs: 15,
    });
    eq('a slow turn still returns its value', out, 'answer');
    eq('and sends EXACTLY ONE note, never a heartbeat', sent.filter(s => s === 'note').length, 1);
    check('and reports it as sent', sent.includes('report:sent'));
    await sleep(60);
    eq('and still exactly one after the call returns', sent.filter(s => s === 'note').length, 1);
  }

  // The note itself fails. The answer must survive it.
  {
    const reports: string[] = [];
    const out = await withProgressNote(async () => { await sleep(60); return 'answer'; }, {
      inboundAt: NOW,
      send: async () => { throw new Error('graph 500'); },
      report: (outcome, error) => reports.push(`${outcome}:${error ?? ''}`),
      delayMs: 10,
    });
    eq('A FAILED NOTE NEVER BREAKS THE ANSWER', out, 'answer');
    check('and the failure is reported, not swallowed silently', reports[0]?.startsWith('failed:'));
  }

  // The turn throws. The note must not mask it, and must not leak either.
  {
    const reports: string[] = [];
    let threw = '';
    try {
      await withProgressNote(async () => { await sleep(40); throw new Error('turn blew up'); }, {
        inboundAt: NOW,
        send: async () => {},
        report: outcome => reports.push(outcome),
        delayMs: 10,
      });
    } catch (err) {
      threw = err instanceof Error ? err.message : String(err);
    }
    eq('a throwing turn still propagates its error', threw, 'turn blew up');
    eq('and the note it had already fired is still accounted for', reports.length, 1);
  }
}

// ── the one recoverable send failure ────────────────────────────────────────
// 131047 means "the envelope was wrong, the recipient is fine", so the briefing
// retries that person with a template inside the same notification_log claim.
// It must be recognised NARROWLY: every other failure means the send is
// genuinely broken, and re-sending it as a template would spend money to reach
// the same wall.
{
  const body = (code: number) => JSON.stringify({ error: { message: 'nope', code } });
  eq('the code is Meta\'s re-engagement error', OUTSIDE_WINDOW_ERROR_CODE, 131047);
  check('131047 is recoverable', isOutsideWindowError(new WhatsAppSendError(400, body(131047))));
  // The ones that must NOT trigger a template retry.
  check('131026 (undeliverable) is not', !isOutsideWindowError(new WhatsAppSendError(400, body(131026))));
  check('131030 (allow-list) is not', !isOutsideWindowError(new WhatsAppSendError(400, body(131030))));
  check('132000 (bad parameter) is not', !isOutsideWindowError(new WhatsAppSendError(400, body(132000))));
  // A 500 with an HTML body parses to code null — a broken gateway, not a
  // window problem.
  check('an unparseable error body is not', !isOutsideWindowError(new WhatsAppSendError(502, '<html>bad gateway')));
  check('a plain Error is not', !isOutsideWindowError(new Error('boom')));
  check('null is not', !isOutsideWindowError(null));
  check('undefined is not', !isOutsideWindowError(undefined));
  // A DIFFERENT error class carrying the same number must not qualify either:
  // the code alone is not the signal, the class is half of it.
  check('a look-alike object is not', !isOutsideWindowError({ code: 131047 }));
}

// ── the free-form briefing body (issue #46, defect 4) ───────────────────────
// "Canalização" on its own tells a plumber nothing. The free-form envelope has
// no template constraints, so it carries the description and the materials —
// the two fields that were always in task_board and could never fit in a
// one-line template parameter.
{
  function task(over: Partial<BriefingTask> = {}): BriefingTask {
    return {
      id: uuid,
      title: 'Canalização',
      job_name: 'Casa de Paco',
      overdue: false,
      days_overdue: 0,
      description: 'Substituir os tubos da cozinha.',
      materials: ['tubo PVC 50mm', 'cola', 'fita'],
      job_address: 'Rua das Flores 12, Lisboa',
      waiting_on: ['Demolir parede'],
      awaiting_review: false,
      due_date: '2026-08-20',
      ...over,
    };
  }
  function briefing(tasks: BriefingTask[]): WorkerBriefing {
    return {
      workerId: uuid,
      name: 'Miguel',
      recipient: { kind: 'phone', waId },
      locale: 'pt-PT',
      hasChosenLanguage: false,
      tasks,
      lastInboundAt: null,
    };
  }

  const one = renderWorkerFreeForm(briefing([task()]));
  check('the body greets by name', one.includes('Miguel'), one);
  check('and names the task', one.includes('Canalização'), one);
  check('and its obra', one.includes('Casa de Paco'), one);
  // THE defect. Before this renderer the message was the title and nothing else.
  check('AND THE DESCRIPTION', one.includes('Substituir os tubos da cozinha.'), one);
  check('AND THE MATERIALS', one.includes('tubo PVC 50mm') && one.includes('fita'), one);
  // Newlines are the whole reason this is not a template parameter.
  check('the body uses newlines', one.includes('\n'), JSON.stringify(one));
  // Defect 3: we already know their language, so we never ask them to pick one.
  check(
    'and never explains how to change language',
    !/\bPT\b.*\bES\b.*\bEN\b/i.test(one) && !/STOP/i.test(one),
    one,
  );

  // A row with neither field degrades to what the template used to send — never
  // worse than today, only better when the data is there.
  const bare = renderWorkerFreeForm(briefing([task({ description: null, materials: [] })]));
  check('a bare task is still a complete message', bare.includes('Canalização'), bare);
  check('and invents no empty Material line', !bare.includes('Material:'), bare);

  const idle = renderWorkerFreeForm(briefing([]));
  check('a worker with nothing on still gets a message', idle.includes('Miguel'), idle);
  check('and it says so', idle.includes(getCatalog('pt-PT').reminders.workerNothing), idle);

  // Truncation. There is no second message at 07:00, so a long list is trimmed
  // rather than split.
  const manyMaterials = renderWorkerFreeForm(
    briefing([task({ materials: Array.from({ length: 20 }, (_, i) => `material ${i}`) })]),
  );
  check('a 20-item material list is truncated', !manyMaterials.includes('material 19'), manyMaterials);
  check('and says how many were left out', manyMaterials.includes('+14'), manyMaterials);
  check('while still showing the first ones', manyMaterials.includes('material 0'), manyMaterials);

  const manyTasks = renderWorkerFreeForm(
    briefing(Array.from({ length: 9 }, (_, i) => task({ title: `Tarefa ${i}` }))),
  );
  check('more than five tasks are truncated', !manyTasks.includes('Tarefa 8'), manyTasks);
  check('and the remainder is counted', manyTasks.includes('+4'), manyTasks);

  const longDescription = renderWorkerFreeForm(briefing([task({ description: 'x'.repeat(1000) })]));
  check('an essay of a description is cut', !longDescription.includes('x'.repeat(500)), 'not truncated');

  // The last-resort cap. Even a pathological row must fit one WhatsApp message,
  // because two pushes at 07:00 read worse than a trimmed one.
  const pathological = renderWorkerFreeForm(
    briefing(
      Array.from({ length: 5 }, (_, i) =>
        task({
          title: `${'T'.repeat(400)} ${i}`,
          description: 'd'.repeat(1000),
          materials: Array.from({ length: 30 }, () => 'm'.repeat(200)),
        }),
      ),
    ),
  );
  check(
    'even a pathological briefing fits one WhatsApp message',
    pathological.length <= 4000,
    `${pathological.length} chars`,
  );
  eq('so it is never split', splitForWhatsApp(pathological).length, 1);

  // Overdue-first, the same ordering the template path uses — the two envelopes
  // may differ in detail but never in which task is most urgent.
  const mixedOrder = renderWorkerFreeForm(
    briefing([
      task({ title: 'A tempo', overdue: false }),
      task({ title: 'Atrasada', overdue: true, days_overdue: 3 }),
    ]),
  );
  check(
    'the overdue task is listed first',
    mixedOrder.indexOf('Atrasada') < mixedOrder.indexOf('A tempo'),
    mixedOrder,
  );
  check('and is marked with its age', mixedOrder.includes('3'), mixedOrder);

  // Every locale must render, with no `undefined` leaking from a missing key.
  for (const locale of LOCALES) {
    const body = renderWorkerFreeForm({ ...briefing([task()]), locale });
    check(`${locale} — renders a body`, body.length > 0);
    check(`${locale} — leaks no undefined`, !body.includes('undefined'), body);
    check(`${locale} — still carries the materials`, body.includes('tubo PVC 50mm'), body);
  }
}

// ── committed template definitions ──────────────────────────────────────────
// These are the mistakes that would otherwise surface as a Meta rejection days
// later, or as an approved template that silently means the wrong thing.
const defs = allTemplates();

// Every managed name must be defined in every locale. This is the assertion
// that would have caught capo_daily_briefing's missing es_ES and en_US before
// they became a daily 132001 in notification_log — the template existed, just
// not in the language the recipient was on, and nothing in CI could see that
// while the definition lived only in WhatsApp Manager.
eq('a definition per managed template per locale', defs.length, MANAGED_TEMPLATE_NAMES.length * LOCALES.length);
for (const name of MANAGED_TEMPLATE_NAMES) {
  for (const language of TEMPLATE_LANGUAGES) {
    check(`${name} is defined in ${language}`, defs.some(d => d.name === name && d.language === language));
  }
}

for (const def of defs) {
  const locale = LOCALES.find(l => getCatalog(l).reminders.templateLanguage === def.language)!;
  const label = `${def.name} ${def.language}`;
  check(`${label} — language matches a real locale`, Boolean(locale));
  eq(`${label} — category`, def.category, 'UTILITY');
  eq(`${label} — parameter format`, def.parameter_format, 'POSITIONAL');

  const body = def.components.find(c => c.type === 'BODY') as { text: string; example: { body_text: string[][] } };
  const text = body.text;
  eq(`${label} — has {{1}} exactly once`, (text.match(/\{\{1\}\}/g) ?? []).length, 1);
  eq(`${label} — has {{2}} exactly once`, (text.match(/\{\{2\}\}/g) ?? []).length, 1);
  eq(`${label} — has no {{3}}`, text.includes('{{3}}'), false);
  // Meta rejects a body that starts or ends with a parameter.
  check(`${label} — does not start with a parameter`, !text.trimStart().startsWith('{{'), text.slice(0, 12));
  check(`${label} — does not end with a parameter`, !text.trimEnd().endsWith('}}'), text.slice(-12));
  // Sample count is validated against parameter count on submit.
  eq(`${label} — supplies two example values`, body.example.body_text[0]?.length, 2);

  // Buttons are asymmetric ON PURPOSE and the asymmetry is load-bearing.
  // capo_task_checkin is answered by tapping; capo_daily_briefing is answered
  // with free text (PT/ES/EN/STOP). Declaring a button component on a send
  // whose approved template has none earns a 132000 on every send, so a stray
  // BUTTONS block here would take the whole 07:00 briefing down.
  const buttonComponent = def.components.find(c => c.type === 'BUTTONS') as
    | { buttons: { type: string; text: string }[] }
    | undefined;
  if (def.name !== 'capo_task_checkin') {
    check(`${label} — declares no buttons`, buttonComponent === undefined);
    continue;
  }

  const buttons = buttonComponent!.buttons;
  eq(`${label} — exactly two buttons`, buttons.length, 2);
  check(`${label} — both are quick replies`, buttons.every(b => b.type === 'QUICK_REPLY'));
  // The labels must be the catalog's, in done-then-notDone order — the same
  // order /api/cron/checkin mints payloads in.
  const t = getCatalog(locale!).whatsapp;
  eq(`${label} — button 0 is the done label`, buttons[0].text, t.checkinDoneButton);
  eq(`${label} — button 1 is the not-done label`, buttons[1].text, t.checkinNotDoneButton);
  check(`${label} — labels differ`, buttons[0].text !== buttons[1].text);
  for (const b of buttons) {
    check(`${label} — "${b.text}" is 1..25 chars`, b.text.length >= 1 && b.text.length <= 25, `${b.text.length}`);
  }
}

// ── outbound planning ───────────────────────────────────────────────────────
const labels: ApprovalLabels = { approve: 'Aprobar', reject: 'Rechazar', prompt: '¿Apruebas, jefe?', fallback: 'Hazlo en la app.' };

function text(value: string): UIMessage['parts'][number] {
  return { type: 'text', text: value };
}

// Shaped exactly like what propose.ts / guard.ts / plan.ts return, wrapped in
// the AI SDK's tool part. `as` is needed because the SDK's part union is keyed
// on a template-literal tool name.
function card(renderedText: string, proposalId = uuid): UIMessage['parts'][number] {
  return {
    type: 'tool-propose',
    toolCallId: 'call-1',
    state: 'output-available',
    input: {},
    output: { status: 'proposed', proposalId, renderedText },
  } as unknown as UIMessage['parts'][number];
}

function toolOutput(output: unknown): UIMessage['parts'][number] {
  return {
    type: 'tool-list_tasks',
    toolCallId: 'call-2',
    state: 'output-available',
    input: {},
    output,
  } as unknown as UIMessage['parts'][number];
}

// THE regression guard for defect 1, and for "cards must not pile up at the
// end": a card has to land where it occurred in the turn.
const interleaved = planAssistantMessages([text('antes'), card('Crear tarea: «x».'), text('depois')], labels);
eq('a card is delivered, not dropped', interleaved.length, 3);
eq('prose before the card comes first', interleaved[0]?.kind, 'text');
eq('the card keeps its position', interleaved[1]?.kind, 'interactive');
eq('prose after the card comes last', interleaved[2]?.kind, 'text');
eq('trailing prose is not merged into the card', interleaved[2]?.body, 'depois');

// A short card IS the interactive body, byte-identical — rendered_text is the
// persisted approval artifact and must never be reworded or converted.
const short = planAssistantMessages([card('Crear tarea: «Pintar» en la obra Casa de Paco.')], labels);
eq('a short card is one interactive message', short.length, 1);
eq('a short card body is byte-identical', short[0]?.body, 'Crear tarea: «Pintar» en la obra Casa de Paco.');

// A markdown-looking card is still sent verbatim.
const literal = planAssistantMessages([card('Crear obra: «Casa **de** Paco».')], labels);
eq('card text is never markdown-converted', literal[0]?.body, 'Crear obra: «Casa **de** Paco».');

// Over 1024: the card goes as text, then a short interactive carries the
// buttons. Every real plan card takes this branch.
const big = planAssistantMessages([card('L'.repeat(2000))], labels);
eq('an over-limit card becomes text + interactive', big.length, 2);
eq('the card text is sent first', big[0]?.kind, 'text');
eq('the buttons follow in an interactive', big[1]?.kind, 'interactive');
eq('the interactive falls back to the prompt', big[1]?.body, labels.prompt);

const huge = planAssistantMessages([card('L'.repeat(6000))], labels);
eq('a 6k card splits across two texts + interactive', huge.length, 3);
eq('the last message carries the buttons', huge[2]?.kind, 'interactive');

// Meta's hard limits, asserted across every fixture.
const all = [...interleaved, ...short, ...literal, ...big, ...huge];
check(
  'every interactive body fits Meta\'s 1024 limit',
  all.every(m => m.kind !== 'interactive' || m.body.length <= 1024),
);
check('every text body fits the 4000-char split', all.every(m => m.kind !== 'text' || m.body.length <= 4000));
check(
  'every button title fits Meta\'s 20-char limit',
  all.every(m => m.kind !== 'interactive' || m.buttons.every(b => b.title.length <= 20)),
);
check(
  'the two button titles are distinct (Meta requires it)',
  all.every(m => m.kind !== 'interactive' || m.buttons[0]?.title !== m.buttons[1]?.title),
);
check(
  'every card offers exactly approve and reject',
  all.every(m => m.kind !== 'interactive' || m.buttons.length === 2),
);

// A long translation must degrade to a truncated label, never to a Meta 400.
const truncated = planAssistantMessages(
  [card('curto')],
  { approve: 'Aprovar esta proposta agora', reject: 'Rejeitar', prompt: 'p', fallback: 'f' },
);
eq('an over-long label is truncated, not passed through', truncated[0]?.kind === 'interactive'
  ? truncated[0].buttons[0]?.title.length
  : -1, 20);

// Parts that are not proposals must not produce buttons.
const noise = planAssistantMessages(
  [
    { type: 'step-start' } as UIMessage['parts'][number],
    { type: 'reasoning', text: 'pensando' } as UIMessage['parts'][number],
    toolOutput({ status: 'ok', rows: [] }),
    toolOutput({ status: 'error', message: 'boom' }),
    text('pronto'),
  ],
  labels,
);
eq('non-proposal parts yield only the prose', noise.length, 1);
eq('and no tool chips leak into WhatsApp', noise[0]?.body, 'pronto');

// The old sink returned early when there was no text, swallowing the card.
const silent = planAssistantMessages([card('Crear tarea: «x».')], labels);
eq('a card with no prose is still delivered', silent.length, 1);

// Prose is converted on the way out.
const converted = planAssistantMessages([text('Obra creada: **Casa de Paco**.')], labels);
eq('prose is markdown-converted', converted[0]?.body, 'Obra creada: *Casa de Paco*.');

// ── the worker sink (PRD 4 / issue #22) ─────────────────────────────────────
// The crew channel is prose and nothing else. A worker's roster has no
// `propose`, no guarded write and no way to construct the ToolContext
// createProposal demands — the absence is enforced by the type checker, and
// these three checks pin the RUNTIME half of it.
//
// The throw is the interesting one. Silently skipping a card here would be the
// exact defect this file's check 1 exists for, made worse: on the worker path
// it would be the only signal that the two rosters had stopped being isolated,
// and it would arrive as nothing at all.
{
  const workerParts = [text('Hoje tens a pintura do 2.º andar.')];
  const out = planWorkerMessages(workerParts);
  eq('a worker turn is one plain text message', out.length, 1);
  eq('and it is never interactive', out[0]?.kind, 'text');

  const converted = planWorkerMessages([text('Precisas de **primário** e rolo.')]);
  eq('worker prose is markdown-converted too', converted[0]?.body, 'Precisas de *primário* e rolo.');

  eq('non-proposal tool outputs are ignored', planWorkerMessages([toolOutput({ status: 'ok', tasks: [] }), text('pronto')]).length, 1);

  eq('a silent turn sends nothing', planWorkerMessages([]).length, 0);

  const long = planWorkerMessages([text('L'.repeat(6000))]);
  check('a long worker reply is split, never truncated', long.length === 2 && long.every(m => m.body.length <= 4000));

  let threw = false;
  try {
    planWorkerMessages([card('Crear tarea: «x».')]);
  } catch {
    threw = true;
  }
  check('a proposal on the worker path THROWS rather than being dropped', threw);
}

// ── the guided menu (issue #49) ─────────────────────────────────────────────
// Federico's complaint was three complaints. This section covers all three,
// and every one of them is a place where being wrong is SILENT:
//
//  13. The 07:00 briefing named a task and nothing else — no address, no
//      description, no materials. Every one of those was already in task_board
//      and read by nobody who talks to the crew. A renderer that quietly stops
//      including one of them produces a message that still looks fine.
//  14. "Reply PT, ES or EN to change language" was on EVERY send, because it
//      was baked into an approved template body. It now lives in the {{2}}
//      parameter and must appear ONLY when the caller asks for it. Getting the
//      default wrong reinstates the complaint with no error anywhere.
//  15. The guided list is the THIRD tappable shape on one webhook and the
//      SECOND under `type: 'interactive'`. Nothing about the handler layout
//      keeps them apart — only the fact that the three id prefixes are pairwise
//      non-overlapping, so each of the six directions is asserted below.
//  16. Three keyword tables now sit in front of the worker agent, and they must
//      stay disjoint. The one that must never move is `es`: a bare "ES" has to
//      keep resolving to Spanish with ZERO model calls, and a collision would
//      route it to a menu or an opt-out instead, cheerfully.
//  17. Meta's interactive-list limits are enforced by clamping (cosmetic) and
//      throwing (structural). The body cap is deliberately the conservative
//      figure — Meta's own page and every third-party summary disagree — because
//      being wrong upward is a 400 at 07:00 and a crew that hears nothing.

// ── the three id codecs, pairwise ───────────────────────────────────────────
{
  const menuTask = workerMenuRowId({ kind: 'task', taskId: uuid });
  const menuManager = workerMenuRowId({ kind: 'manager' });
  const checkin = checkinPayload('done', uuid);
  const approve = proposalButtonId('approve', uuid);

  eq('a menu task row round-trips (kind)', parseWorkerMenuRowId(menuTask)?.kind, 'task');
  eq(
    'a menu task row round-trips (task id)',
    parseWorkerMenuRowId(menuTask)?.kind === 'task' ? parseWorkerMenuRowId(menuTask)?.taskId : null,
    uuid,
  );
  eq('the manager row round-trips', parseWorkerMenuRowId(menuManager)?.kind, 'manager');
  // The uuid is validated for the same reason the other two codecs validate
  // theirs: taskId goes straight into a comparison against uuid columns.
  eq('a malformed task uuid is rejected', parseWorkerMenuRowId('capo:wm:task:not-a-uuid'), null);
  eq('a foreign prefix is rejected', parseWorkerMenuRowId(`evil:wm:task:${uuid}`), null);
  eq('an empty row id is rejected', parseWorkerMenuRowId(''), null);
  // The manager row carries NO id, so nothing can be looked up from it and
  // nothing can leak through it.
  check('the manager row id contains no uuid', !menuManager.includes(uuid), menuManager);

  // Six directions, all of which must refuse. Two of these three shapes arrive
  // under `type: 'interactive'`, so this is the whole of what keeps a manager's
  // approval from being read as a crew member's menu tap.
  eq('a check-in payload is not a menu row', parseWorkerMenuRowId(checkin), null);
  eq('a proposal id is not a menu row', parseWorkerMenuRowId(approve), null);
  eq('a menu row is not a check-in payload', parseCheckinPayload(menuTask), null);
  eq('the manager row is not a check-in payload', parseCheckinPayload(menuManager), null);
  eq('a menu row is not a proposal id', parseProposalButtonId(menuTask), null);
  eq('the manager row is not a proposal id', parseProposalButtonId(menuManager), null);
}

// ── the keyword tables in front of the agent ────────────────────────────────
{
  const tables: [string, Iterable<string>][] = [
    ['language', Object.keys(LANGUAGE_KEYWORDS)],
    ['opt-out', OPT_OUT_KEYWORDS],
    ['opt-in', OPT_IN_KEYWORDS],
    ['menu', MENU_KEYWORDS],
  ];
  for (let i = 0; i < tables.length; i += 1) {
    for (let j = i + 1; j < tables.length; j += 1) {
      const [nameA, a] = tables[i];
      const [nameB, b] = tables[j];
      const setB = new Set(b);
      const shared = [...a].filter(word => setB.has(word));
      check(`${nameA} and ${nameB} keywords are disjoint`, shared.length === 0, shared.join(', '));
    }
  }

  // THE INVARIANT. A bare "ES" resolves to Spanish from a lookup table — no
  // model, no network, no database. If any of these four ever change, the
  // cheapest and most-used control the crew has just became a paid model turn.
  eq('a bare ES resolves to Spanish', languageCommand('ES'), 'es-ES');
  eq('and is case- and whitespace-insensitive', languageCommand('  es  '), 'es-ES');
  eq('the menu never claims it', menuCommand('ES'), false);
  eq('and neither does consent', consentCommand('ES'), null);
  eq('PT and EN resolve too', `${languageCommand('pt')}/${languageCommand('EN')}`, 'pt-PT/en-US');

  // Whole-message only, in all three tables. A substring match would read a
  // sentence as a command, silently, in the direction that costs somebody their
  // message.
  eq('a sentence starting with es is not a language switch', languageCommand('es que falta material'), null);
  eq('a sentence starting with stop is not an opt-out', consentCommand('stop, o Zé não vem hoje'), null);
  eq('a sentence starting with ajuda is not a menu request', menuCommand('ajuda-me a perceber isto'), false);
  eq('an empty message is no command at all', menuCommand(''), false);
  eq('and neither is undefined', menuCommand(undefined), false);
}

// ── the interactive list payload ────────────────────────────────────────────
{
  const rows = [
    { id: workerMenuRowId({ kind: 'task', taskId: uuid }), title: 'Canalização', description: 'Casa de Paco' },
    { id: workerMenuRowId({ kind: 'manager' }), title: 'Falar com o chefe' },
  ];
  const payload = buildListPayload({ body: 'Bom dia, Miguel.', button: 'Ver tarefa', section: 'As tuas tarefas', rows });
  const interactive = payload.interactive as Record<string, unknown>;
  const action = interactive.action as Record<string, unknown>;
  const sections = action.sections as { title: string; rows: { id: string; title: string; description?: string }[] }[];

  eq('a list is an interactive message', payload.type, 'interactive');
  eq('of subtype list', interactive.type, 'list');
  eq('with exactly one section', sections.length, 1);
  eq('carrying both rows', sections[0].rows.length, 2);
  // No header and no footer — a footer is exactly where a standing "reply
  // PT/ES/EN" sentence would grow back, which is the complaint being fixed.
  check('a list has no header', !('header' in interactive), JSON.stringify(Object.keys(interactive)));
  check('and no footer', !('footer' in interactive), JSON.stringify(Object.keys(interactive)));
  // A row with no description must OMIT the key rather than send an empty one.
  check('a description-less row omits the key', !('description' in sections[0].rows[1]), JSON.stringify(sections[0].rows[1]));

  // Cosmetic overruns CLAMP: a long task title is still tappable.
  const clamped = buildListPayload({
    body: 'x',
    button: 'B'.repeat(60),
    section: 'S'.repeat(60),
    rows: [{ id: 'capo:wm:manager', title: 'T'.repeat(60), description: 'D'.repeat(200) }],
  });
  const clampedAction = ((clamped.interactive as Record<string, unknown>).action) as Record<string, unknown>;
  const clampedSections = clampedAction.sections as { title: string; rows: { title: string; description?: string }[] }[];
  check('a long button label is clamped to 20', (clampedAction.button as string).length <= 20, clampedAction.button as string);
  check('a long section title is clamped to 24', clampedSections[0].title.length <= 24, clampedSections[0].title);
  check('a long row title is clamped to 24', clampedSections[0].rows[0].title.length <= 24, clampedSections[0].rows[0].title);
  check('a long row description is clamped to 72', (clampedSections[0].rows[0].description ?? '').length <= 72);

  // Structural overruns THROW. A truncated body would silently drop half a
  // briefing; a truncated id comes back unparseable and the tap vanishes.
  function throws(fn: () => unknown): boolean {
    try {
      fn();
      return false;
    } catch {
      return true;
    }
  }
  check('an oversized body throws', throws(() => buildListPayload({ body: 'x'.repeat(1025), button: 'b', section: 's', rows })));
  check('an empty body throws', throws(() => buildListPayload({ body: '', button: 'b', section: 's', rows })));
  check('zero rows throws', throws(() => buildListPayload({ body: 'x', button: 'b', section: 's', rows: [] })));
  check(
    'eleven rows throws',
    throws(() =>
      buildListPayload({
        body: 'x',
        button: 'b',
        section: 's',
        rows: Array.from({ length: 11 }, () => ({ id: 'capo:wm:manager', title: 't' })),
      }),
    ),
  );
  check(
    'an over-long row id throws',
    throws(() => buildListPayload({ body: 'x', button: 'b', section: 's', rows: [{ id: 'i'.repeat(201), title: 't' }] })),
  );

  // listFits is the seam that keeps the 07:00 send out of that throw: the
  // briefing asks BEFORE building, and a day that does not fit is sent as
  // ordinary text, which holds four times as much.
  check('listFits accepts a 1024-char body', listFits('x'.repeat(1024)));
  check('and refuses 1025', !listFits('x'.repeat(1025)));
  check('and refuses an empty one', !listFits(''));

  // Exactly one addressing field, the same property buildSendBody guarantees
  // for every other send: `to` XOR `recipient`, never both, because Meta lets
  // `to` win silently and a BSUID send would go to a stale phone number and
  // report success.
  const bsuidBody = buildSendBody(payload, { kind: 'bsuid', userId: 'PT.13491208655302741918' });
  check('a list to a BSUID uses recipient', 'recipient' in bsuidBody && !('to' in bsuidBody), JSON.stringify(Object.keys(bsuidBody)));
  const phoneBody = buildSendBody(payload, { kind: 'phone', waId });
  check('and a list to a phone uses to', 'to' in phoneBody && !('recipient' in phoneBody), JSON.stringify(Object.keys(phoneBody)));
}

// ── the briefing content, the language line, and the menu rows ──────────────
{
  function task(over: Partial<BriefingTask> = {}): BriefingTask {
    return {
      id: uuid,
      title: 'Canalização',
      job_name: 'Casa de Paco',
      overdue: false,
      days_overdue: 0,
      description: 'Substituir os tubos da cozinha.',
      materials: ['tubo PVC 50mm', 'cola'],
      due_date: '2026-08-20',
      job_address: 'Rua das Flores 12, Lisboa',
      waiting_on: ['Demolir parede'],
      awaiting_review: false,
      due_date: '2026-08-20',
      ...over,
    };
  }
  function briefing(over: Partial<WorkerBriefing> = {}): WorkerBriefing {
    return {
      workerId: uuid,
      name: 'Miguel',
      recipient: { kind: 'phone', waId },
      locale: 'pt-PT',
      hasChosenLanguage: false,
      tasks: [task()],
      lastInboundAt: null,
      ...over,
    };
  }

  // COMPLAINT 1. The two facts #46 did not add, both of which had been sitting
  // in task_board all along.
  const body = renderWorkerFreeForm(briefing());
  check('the briefing now says WHERE', body.includes('Rua das Flores 12, Lisboa'), body);
  check('and what the task waits on', body.includes('Demolir parede'), body);
  check('while keeping the description', body.includes('Substituir os tubos da cozinha.'), body);
  check('and the materials', body.includes('tubo PVC 50mm'), body);
  // A task with none of them degrades to its title, exactly as before.
  const bare = renderWorkerFreeForm(
    briefing({ tasks: [task({ description: null, materials: [], job_address: null, waiting_on: [] })] }),
  );
  check('a bare task invents no empty address line', !bare.includes('Morada'), bare);
  check('and no empty dependency line', !bare.includes('Depende de'), bare);

  // COMPLAINT 2. Off by default, everywhere, in every locale.
  for (const locale of LOCALES) {
    const hint = getCatalog(locale).reminders.languageHint;
    const [, off] = renderWorkerBriefing(briefing({ locale }));
    const [, on] = renderWorkerBriefing(briefing({ locale }), { languageHint: true });
    check(`${locale} — the template summary carries no language line by default`, !off.includes(hint), off);
    check(`${locale} — and carries it when the caller asks`, on.includes(hint), on);
    // Appended, never prepended: the work comes first.
    check(`${locale} — the hint is at the end`, on.endsWith(hint), on);
    // An idle worker gets it too — first contact is first contact whether or
    // not there is anything on that day.
    const [, idle] = renderWorkerBriefing(briefing({ locale, tasks: [] }), { languageHint: true });
    check(`${locale} — an idle first-contact worker gets it`, idle.includes(hint), idle);
    // The FREE-FORM briefing never carries it, in any configuration: being
    // inside that window is itself proof this person has written to us.
    check(
      `${locale} — the free-form briefing never carries it`,
      !renderWorkerFreeForm(briefing({ locale })).includes(hint),
      locale,
    );
  }
  // THE PUNCTUATION, which is only ever visible on a live send to a crew
  // member on their first ever contact. {{2}} is dropped into the middle of the
  // approved body — "Hoje tens: {{2}}. Responde STOP…" — so the hint must carry
  // no full stop of its own, and the text it is appended to must not keep one
  // either. Both directions produce a message that reads broken and nothing
  // else in this repo would notice.
  for (const locale of LOCALES) {
    const hint = getCatalog(locale).reminders.languageHint;
    check(`${locale} — the hint carries no trailing full stop`, !/[.。]$/.test(hint), hint);
    const [, listed] = renderWorkerBriefing(briefing({ locale }), { languageHint: true });
    const [, nothing] = renderWorkerBriefing(briefing({ locale, tasks: [] }), { languageHint: true });
    // `workerNothing` ends in a full stop and a task list does not; both must
    // land on exactly one before the hint.
    check(`${locale} — no doubled full stop after a task list`, !listed.includes('..'), listed);
    check(`${locale} — nor after "nothing today"`, !nothing.includes('..'), nothing);
    check(`${locale} — and the hint is still a separate sentence`, nothing.includes(`. ${hint}`), nothing);
  }

  // A template parameter is one line. toTemplateParam flattens whitespace, so
  // the hint must survive that rather than be the thing that breaks it.
  const [, withHint] = renderWorkerBriefing(briefing(), { languageHint: true });
  check('the hinted summary survives toTemplateParam', toTemplateParam(withHint).includes(getCatalog('pt-PT').reminders.languageHint));
  check('and stays newline-free', !/[\n\t]/.test(toTemplateParam(withHint)));

  // The approved template body must no longer state it — that is the half of
  // complaint 2 this repository owns.
  for (const def of allTemplates().filter(d => d.name === 'capo_daily_briefing')) {
    const text = String((def.components.find(c => c.type === 'BODY') as { text?: string } | undefined)?.text ?? '');
    check(`${def.language} — the briefing template no longer offers PT/ES/EN`, !/\bPT\b/.test(text), text);
    // STOP stays: Meta expects a utility template to state its opt-out.
    check(`${def.language} — but still states the opt-out`, /STOP/i.test(text), text);
  }

  // COMPLAINT 3. The menu, built from the same rows the briefing renders.
  const menu = buildWorkerMenu({ tasks: [task()], body: 'Bom dia, Miguel.', locale: 'pt-PT' });
  check('a menu is built', !!menu);
  eq('with one row per task plus the manager row', menu?.rows.length, 2);
  eq('and the manager row is ALWAYS last', menu?.rows.at(-1)?.id, workerMenuRowId({ kind: 'manager' }));
  check('the task row carries its id', menu!.rows[0].id === workerMenuRowId({ kind: 'task', taskId: uuid }), menu!.rows[0].id);
  check('and names the obra in its sub-line', (menu!.rows[0].description ?? '').includes('Casa de Paco'), menu!.rows[0].description ?? '');

  // Row limits are respected at the SOURCE as well as at the payload, so a
  // dictionary can reason about the shape it will actually produce.
  const longMenu = buildWorkerMenu({
    tasks: Array.from({ length: 20 }, (_, i) => task({ id: uuid, title: `Uma tarefa com um título muito longo ${i}` })),
    body: 'x',
    locale: 'pt-PT',
  });
  check('no more than ten rows ever', (longMenu?.rows.length ?? 0) <= 10, String(longMenu?.rows.length));
  check('every row title fits 24 chars', longMenu!.rows.every(r => r.title.length <= 24));
  check('every row description fits 72', longMenu!.rows.every(r => (r.description ?? '').length <= 72));
  // And the whole thing still builds — the payload builder is the last word.
  check('the capped menu still builds a payload', !!buildListPayload(longMenu!));

  // A body that does not fit is NOT an error: the caller sends plain text,
  // which holds four times as much. A rich morning beats a menu.
  eq('an oversized body yields no menu', buildWorkerMenu({ tasks: [task()], body: 'x'.repeat(1025), locale: 'pt-PT' }), null);

  // Overdue first, the same ordering both briefing renderers use — the list and
  // the text of the SAME message must not disagree about what is urgent.
  const ordered = buildWorkerMenu({
    tasks: [task({ title: 'A tempo' }), task({ title: 'Atrasada', overdue: true })],
    body: 'x',
    locale: 'pt-PT',
  });
  eq('the overdue task is the first row', ordered?.rows[0].title, 'Atrasada');

  // The task sheet behind a tap. Same facts, same renderer, no surrounding day.
  const sheet = renderTaskDetail(task(), 'pt-PT');
  check('the sheet names the task and obra', sheet.includes('Canalização') && sheet.includes('Casa de Paco'), sheet);
  check('and the address', sheet.includes('Rua das Flores 12, Lisboa'), sheet);
  check('and the materials', sheet.includes('tubo PVC 50mm'), sheet);
  // A task with nothing recorded says so and points at a person, rather than
  // echoing a lonely title that reads like a broken feature.
  const emptySheet = renderTaskDetail(
    task({ description: null, materials: [], job_address: null, waiting_on: [], due_date: null }),
    'pt-PT',
  );
  check('an empty task says there is nothing more', emptySheet.includes(getCatalog('pt-PT').reminders.detailNothingMore), emptySheet);
  // A task already declared finished is SHOWN in the menu (is_open is a
  // denylist) and says it is waiting on the manager, rather than vanishing.
  const inReview = renderTaskDetail(task({ awaiting_review: true }), 'pt-PT');
  check('a declared task says it is waiting on the manager', inReview.includes(getCatalog('pt-PT').reminders.freeFormAwaitingReview), inReview);

  // THE DEADLINE, and lateness. The sheet has no surrounding day — the briefing
  // does — so a task opened from the menu must say when it is due and whether
  // it is already late. Without it the crew read where/what/materials and have
  // no idea which task to start.
  {
    const due = renderTaskDetail(task({ due_date: '2026-08-20' }), 'pt-PT');
    check('the sheet states the deadline', due.includes('20/08'), due);
    // A stored date is a DATE, not an instant. Formatting it in the runtime's
    // zone reports 2026-08-20 as the 19th anywhere west of Greenwich.
    check('and never shifts it by a day', !due.includes('19/08'), due);
    check('an unparseable date is passed through, never "Invalid Date"', !renderTaskDetail(task({ due_date: 'soon' }), 'pt-PT').includes('Invalid'));
    check('a task with no deadline says nothing about one', !renderTaskDetail(task({ due_date: null }), 'pt-PT').includes('Prazo'));

    const late = renderTaskDetail(task({ overdue: true }), 'pt-PT');
    check('an overdue task says so on the sheet', late.includes(getCatalog('pt-PT').reminders.detailOverdue('')), late);
    // …and NEVER with a day count. This projection has no days_overdue, and
    // `0` must not be rendered as "atrasada 0d".
    check('but never invents a day count', !/atrasada\s*0/.test(late), late);
  }

  // A whitespace-only title must not produce an empty row title. clamp()
  // flattens whitespace, so `title || fallback` evaluated BEFORE the clamp
  // yields '' — which Meta answers with a 400, and on the keyword path that
  // means this worker can never open their menu again.
  {
    const blank = buildWorkerMenu({ tasks: [task({ title: '   ' })], body: 'x', locale: 'pt-PT' });
    check('a whitespace-only title still yields a non-empty row', (blank?.rows[0].title ?? '').length > 0, JSON.stringify(blank?.rows[0]));
    check('and the payload still builds', !!buildListPayload(blank!));
    // The backstop, where every other list limit lives.
    let threwOnEmptyTitle = false;
    try {
      buildListPayload({ body: 'x', button: 'b', section: 's', rows: [{ id: 'capo:wm:manager', title: '   ' }] });
    } catch {
      threwOnEmptyTitle = true;
    }
    check('an empty row title throws in buildListPayload', threwOnEmptyTitle);
  }

  // The keyword menu must not claim more tasks than it shows. `is_open` returns
  // up to 40; the list shows six. Telling somebody "you have 11" above six rows
  // sends them hunting for five that are not there.
  for (const locale of LOCALES) {
    const t2 = getCatalog(locale).whatsapp;
    check(`${locale} — a truncated menu body differs from a complete one`, t2.workerMenuBody(6, 11) !== t2.workerMenuBody(6, 6), t2.workerMenuBody(6, 11));
    check(`${locale} — and names both numbers`, t2.workerMenuBody(6, 11).includes('6') && t2.workerMenuBody(6, 11).includes('11'), t2.workerMenuBody(6, 11));
    check(`${locale} — a complete menu names the count once`, t2.workerMenuBody(3, 3).includes('3'), t2.workerMenuBody(3, 3));
  }

  for (const locale of LOCALES) {
    const s2 = renderTaskDetail(task(), locale);
    check(`${locale} — the task sheet renders`, s2.length > 0);
    check(`${locale} — and leaks no undefined`, !s2.includes('undefined'), s2);
    const m = buildWorkerMenu({ tasks: [task()], body: 'x', locale });
    check(`${locale} — the menu labels leak no undefined`, !JSON.stringify(m).includes('undefined'), JSON.stringify(m));
  }
}

// ── the onboarding handshake link (issue #84) ───────────────────────────────
// The wa.me URL a freshly signed-up manager taps or scans. Pure, so it is
// checkable here — and it needs checking, because every way it can be wrong is
// silent: a link with no digits opens WhatsApp with no recipient, and a link
// whose text was not encoded loses everything after the first '&'.
{
  const NUMBER = '+351911097383';
  const link = buildWhatsAppLink(NUMBER, 'Olá Capo!');
  eq('handshake — the link strips the + and keeps every digit', link?.split('?')[0], 'https://wa.me/351911097383');
  check('handshake — the link is https', link!.startsWith('https://'), link!);
  check('handshake — exactly one query separator', (link!.match(/\?/g) ?? []).length === 1, link!);
  check('handshake — no raw spaces survive encoding', !buildWhatsAppLink(NUMBER, 'a b c')!.includes(' '));

  // Formatting a human might paste in is tolerated; anything that is not E.164
  // is refused outright rather than guessed at.
  eq('handshake — spaces and dashes in the number are tolerated', buildWhatsAppLink('+351 911-097 383', 'x'), link!.replace(/\?.*$/, '?text=x'));
  eq('handshake — a number without a + is refused', buildWhatsAppLink('351911097383', 'x'), null);
  eq('handshake — an empty number is refused', buildWhatsAppLink('', 'x'), null);
  eq('handshake — a too-short number is refused', buildWhatsAppLink('+351', 'x'), null);

  // THE ONE THAT MATTERS. toSendTarget in apps/web/lib/whatsapp.ts is
  // deliberately unexported so no BSUID can reach phone-digit surgery; this
  // builder is a second front door onto the same hazard and must refuse the
  // same shape. A BSUID in a wa.me link would silently address nobody.
  eq('handshake — a BSUID is refused, never digit-stripped', buildWhatsAppLink('PT.13491208655302741918', 'x'), null);

  // Accents and punctuation must survive the round trip. Uses a literal rather
  // than the catalog: the copy arrives in Task 2, and this task must end green.
  {
    const accented = 'Olá! Acabei de me registar. Ajudas-me a começar?';
    const url = new URL(buildWhatsAppLink(NUMBER, accented)!);
    eq('handshake — accented text round-trips through the link', url.searchParams.get('text'), accented);
  }
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(lines.join('\n'));
console.log(`\nWhatsApp check: ${lines.length - failures}/${lines.length} passed; failures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
