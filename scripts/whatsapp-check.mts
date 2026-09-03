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
//  13. Capo wrote like a machine, and the loudest tell was coming from its own
//      instructions: the orchestration policy carried forty em dashes, so the
//      model was imitating the document meant to prevent them. The prompt half
//      of the fix is gated statically by `pnpm voice-check`; this is the other
//      half, at the channel edge. What is pinned here is the SCOPE, because
//      that is where a style rule turns into a correctness bug: the pass runs
//      on model prose and NEVER on an approval card, whose renderedText is the
//      persisted record of what the manager approved and is read back
//      byte-for-byte by the web card, the operator app and the audit trail.
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
  parsePhotoBatchPayload,
  parseProposalButtonId,
  parseWorkerMenuRowId,
  photoBatchPayload,
  planAssistantMessages,
  planWorkerMessages,
  applyVoice,
  applyWhatsAppVoice,
  type VoiceRepair,
  proposalButtonId,
  readMetaErrorCode,
  readSender,
  routeWebhookChanges,
  senderLabel,
  splitForWhatsApp,
  toTemplateParam,
  toWhatsAppMarkdown,
  workerMenuRowId,
  hiPayload,
  isHiPayload,
  isHiTap,
  WhatsAppSendError,
  withinFreeFormWindow,
  type ApprovalLabels,
} from '@capo/core/channels/whatsapp';
import { getCatalog } from '@capo/i18n/catalog';
// 0047 — the photo inbox's pure half. Credential-free by construction: the
// reader and the writer take `now` as an argument for exactly this reason.
import {
  MAX_INBOX_PHOTOS,
  PHOTO_INBOX_TTL_MS,
  photoInboxExpiry,
  photoInboxLive,
} from '@capo/core/media/photo-inbox';
import { taskPhotoInboxPath, taskPhotoPath } from '@capo/core/media/photos';
import { PHOTO_REQUEST_TTL_MS, photosSinceRequest } from '../apps/web/lib/checkin-photo.ts';
import { LOCALES, type Locale } from '@capo/i18n/locale';
import { allTemplates, MANAGED_TEMPLATE_NAMES, TEMPLATE_LANGUAGES } from './whatsapp-templates.ts';
// The free-form renderer lives in the web app rather than @capo/core, for the
// same reason renderWorkerBriefing does: it needs the USER copy catalog, which
// must never enter the agent bundle. Reached the same way scheduler-check
// reaches apps/web/lib/cron — it is pure, so no credentials come with it.
import {
  loadCompanyBriefing,
  loadWorkerBriefing,
  renderCheckinAnswerEvent,
  renderCheckinEvent,
  renderManagerEvent,
  renderWorkerBriefing,
  renderWorkerFreeForm,
  renderWorkerKnock,
  type BriefingTask,
  type WorkerBriefing,
} from '../apps/web/app/notifications/briefing.ts';
// The KNOCK's per-locale template switch (issue #108). A hand-maintained
// mirror of Meta's approval state, pure so the whole matrix is assertable.
import {
  BRIEFING_V2_APPROVED_LANGUAGES,
  briefingTemplateFor,
} from '../apps/web/lib/briefing-template.ts';
// The IMMEDIATE ASSIGNMENT NOTE (issue W7). Pure renderers plus the two gates
// that decide whether anything is sent at all — the working-day hours and the
// per-locale template approval — reached the same way and for the same reason.
import {
  renderAssignmentMessage,
  renderAssignmentTemplateParam,
} from '../apps/web/lib/task-assigned-message.ts';
import {
  TASK_ASSIGNED_APPROVED_LANGUAGES,
  taskAssignedTemplateApproved,
} from '../apps/web/lib/task-assigned-template.ts';
// The DECISION half: what to do about one crew member's queued notices, and the
// claim-then-send ORDER, which is the only defence the free-form path has
// against two overlapping drains.
import {
  claimThenSend,
  decideDelivery,
  ENGAGED_OUTCOMES,
  noticeIsStale,
} from '../apps/web/lib/task-assigned-plan.ts';
import { withinAssignmentHours } from '../apps/web/lib/task-assigned-window.ts';
// The GUIDED MENU (issue #49). Pure renderers over the same rows the briefing
// reads, reached the same way — no Db, no clock, no network.
import {
  buildWorkerMenu,
  renderTaskDetail,
} from '../apps/web/app/notifications/worker-menu.ts';
// The WELCOME (issue #45). Same reasoning again — pure renderers plus one
// loader that reads three relations and filters them in TypeScript, so the fake
// Db below drives the real function rather than a re-implementation of it.
import {
  loadPendingWelcomes,
  renderWelcome,
  renderWelcomeEvent,
  renderWelcomeFreeForm,
  WELCOME_KIND,
} from '../apps/web/app/notifications/welcome.ts';
// The welcome RETRY POLICY (issue #121). Pure — no Db, no clock: `today`
// arrives as a string — which is what lets this file pin the three rules that
// keep a released failed claim (0041) from becoming a repeating paid send.
import {
  classifyWelcomeError,
  decideWelcomeRetry,
  WELCOME_MAX_ATTEMPTS,
} from '../apps/web/lib/welcome-retry.ts';
// A crew member's VOICE NOTE (W4). Pure: the predicate, the size cap and the
// transcript-emptiness rule take no clock, no network and no Db, which is what
// lets them be pinned here. `transcribeWorkerAudio` itself is not called.
import {
  isWorkerAudioMessage,
  MIN_WORKER_TRANSCRIPT_CHARS,
  usableTranscript,
  WORKER_AUDIO_MAX_BYTES,
  WORKER_VOCABULARY_SCOPE,
} from '../apps/web/lib/worker-audio.ts';
import {
  buildTranscriptionInstruction,
  MAX_AUDIO_BYTES,
  resolveTranscriptionVocabulary,
} from '@capo/core/transcription';
// Which Meta template the welcome goes out under, per locale, and whether that
// name carries the "Say hi" button. Pure and dependency-free for exactly
// briefing-template.ts's reason — and the two facts come back TOGETHER because
// getting them out of step is a 132000 or an unparseable tap, neither of which
// looks like a failure.
import {
  WELCOME_V2_APPROVED_LANGUAGES,
  welcomeTemplateFor,
} from '../apps/web/lib/welcome-template.ts';
// The one rule that must give the SAME answer in two apps: which manager the
// welcome credits. It lives in @capo/db because apps may not import each other
// (i18n ← db ← core ← {web, operator}), and the drift it prevents is invisible.
import { pickAccountOwnerName } from '@capo/db/account-owner';
// apps/operator's resend renderer. Imported for the same reason the two welcome
// renderers are: it is pure — no Db, no clock, no env at module scope — and it
// is the second place the welcome's words are assembled. The FIRST check in
// this file that reaches into the operator app, and it is here because the
// alternative is that the two renderings drift with nothing able to notice.
import { planWelcomeResend } from '../apps/operator/app/welcome-resend.ts';
// CREW REQUESTS (issue #152). The urgency arithmetic and the two envelopes the
// manager reads. Pure — `today` arrives as a string — which is what lets this
// file pin the rule that replaces "the model decides how urgent this sounds",
// and the boundary that keeps a crew member's words out of `messages`.
import {
  describeUrgency,
  isPressing,
  renderRequestEvent,
  renderRequestMessage,
  urgencyRank,
  type RequestUrgency,
} from '../apps/web/lib/worker-request.ts';
// The fifth crew tool's date guard. In @capo/core because the tool is, and
// re-exported from the worker roster's index for exactly this import.
import { neededByIsSane } from '@capo/core/capabilities/worker';
// The three keyword tables that sit IN FRONT of the worker agent. They moved
// out of the Next route precisely so this file could assert them: three sets
// that must stay pairwise disjoint cannot be checked by reading.
import {
  DETAIL_KEYWORDS,
  LANGUAGE_KEYWORDS,
  MENU_KEYWORDS,
  OPT_IN_KEYWORDS,
  OPT_OUT_KEYWORDS,
  REPORT_KEYWORDS,
  consentCommand,
  detailCommand,
  keywordText,
  languageCommand,
  menuCommand,
  reportCommand,
} from '../apps/web/lib/worker-keywords.ts';
// The pure half of "report a problem" (issue #120): the staging TTL and the
// text clamp. Same reasoning as checkin-photo above — no Db, no clock beyond a
// `now` argument, no network.
import {
  REPORT_REQUEST_TTL_MS,
  REPORT_TEXT_MAX,
  clampReportText,
  reportRequestExpiry,
  reportRequestLive,
} from '../apps/web/lib/problem-report.ts';
// The pure half of "a worker tapped Sim, terminei" (issue #54). Same reasoning
// as the briefing import above: no Db, no clock, no network.
import {
  checkinDoneAck,
  classifyClaimError,
  readTaskIds,
} from '../apps/web/lib/checkin-claim.ts';
// The pure half of the photo follow-up to that tap (issue #52). Same reasoning
// again — no Db, no clock beyond an argument, no network.
import {
  claimedTaskIds,
  nextPhotoTaskId,
  photoRequestExpiry,
  photoRequestLive,
  PHOTO_REQUEST_TTL_MS,
} from '../apps/web/lib/checkin-photo.ts';
// The one-shot progress-note timer (issue #50). Not pure — it schedules — but
// it needs no credentials, no network and no model, and it is the riskiest new
// code in that change: a timer that leaked past its request, or a feedback
// failure that took the real answer down with it, would both be invisible
// everywhere else. Exercised below with millisecond delays.
import { withProgressNote } from '../apps/web/lib/whatsapp-feedback.ts';
import { buildWhatsAppLink } from '../apps/web/lib/whatsapp-handshake.ts';
import { qrGeometry } from '../apps/web/lib/qr.ts';
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
      // `order` is here for loadPendingWelcomes (#45), which reads `profiles`
      // ordered by created_at. It is a no-op: nothing under test depends on the
      // order, only on who is in the set.
      order: () => chain,
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
// A second, distinct proposal id — the two-cards-in-one-turn fixture below.
const uuid2 = '8c40be71-2d93-4a15-b6ef-70a1d5c93b42';
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

// ── the photo follow-up to that tap (issue #52) ─────────────────────────────
// The tap files a claim; the claim needs proof, and until #52 the button path
// asked for none while the agent path required one at the schema level. The
// database half cannot be exercised here, so these pin the pure decisions in
// front of it: WHICH tasks are worth asking about, HOW LONG an unlabelled photo
// may be believed to be about them, and the copy that must never overstate what
// just happened.
{
  const t1 = '11111111-1111-4111-8111-111111111111';
  const t2 = '22222222-2222-4222-8222-222222222222';
  const t3 = '33333333-3333-4333-8333-333333333333';

  // Only tasks now waiting for the manager are worth a photo. `already_pending`
  // counts — same end state, reached earlier — and a worker who re-taps after
  // remembering to photograph something must be able to send it.
  eq(
    'a newly filed claim is worth asking about',
    claimedTaskIds([{ taskId: t1, outcome: 'claimed' }]).join(),
    t1,
  );
  eq(
    'so is one that was already pending',
    claimedTaskIds([{ taskId: t1, outcome: 'already_pending' }]).join(),
    t1,
  );
  // A task the manager closed at lunch, one that vanished, one that errored:
  // there is nothing for a photo to be proof OF.
  eq(
    'a closed, missing or failed task is not',
    claimedTaskIds([
      { taskId: t1, outcome: 'closed' },
      { taskId: t2, outcome: 'missing' },
      { taskId: t3, outcome: 'failed' },
    ]).length,
    0,
  );
  // Order is the snapshot's own, because it is the order they will be asked
  // about — and the ONLY reason that is safe is that the outcomes are paired
  // with their task id at the source rather than zipped by position afterwards.
  eq(
    'the ask order is the snapshot order',
    claimedTaskIds([
      { taskId: t3, outcome: 'claimed' },
      { taskId: t2, outcome: 'closed' },
      { taskId: t1, outcome: 'already_pending' },
    ]).join(','),
    `${t3},${t1}`,
  );

  // The cursor. A stale or malformed index must read as "finished" rather than
  // hand `undefined` to a uuid argument.
  eq('the cursor names the task at its index', nextPhotoTaskId([t1, t2], 1), t2);
  eq('past the end there is nothing left to ask', nextPhotoTaskId([t1, t2], 2), null);
  eq('a negative index is not a task', nextPhotoTaskId([t1, t2], -1), null);
  eq('a fractional index is not a task', nextPhotoTaskId([t1, t2], 1.5), null);
  eq('an empty snapshot asks about nothing', nextPhotoTaskId([], 0), null);

  // THE TTL. Nothing sweeps checkin_photo_requests, so the READER is what makes
  // a request die — and it must fail CLOSED. Believing an unlabelled photo for
  // too long files tomorrow's work as proof of yesterday's claim, silently and
  // with a plausible timestamp.
  const now = Date.UTC(2026, 7, 14, 16, 30);
  eq('an unexpired request is live', photoRequestLive(new Date(now + 60_000).toISOString(), now), true);
  eq('an expired request is not', photoRequestLive(new Date(now - 1).toISOString(), now), false);
  eq('a missing expiry is not', photoRequestLive(null, now), false);
  eq('an unparseable expiry is not', photoRequestLive('not a date', now), false);
  eq(
    'the expiry is exactly the TTL past now',
    Date.parse(photoRequestExpiry(now)) - now,
    PHOTO_REQUEST_TTL_MS,
  );
  // Shorter than Meta's free-form window, and that direction is load-bearing:
  // the follow-up "and the next one?" is free-form text, so a request outliving
  // the window could only be answered by a PAID template, which this path must
  // never send.
  check(
    'the photo window closes before the free-form window does',
    PHOTO_REQUEST_TTL_MS < FREE_FORM_WINDOW_MS,
    `${PHOTO_REQUEST_TTL_MS} vs ${FREE_FORM_WINDOW_MS}`,
  );
  // And short enough that a request opened in the 16:00–17:59 send window is
  // dead long before the next morning's 07:00 briefing.
  check(
    'a request cannot survive until the next briefing',
    PHOTO_REQUEST_TTL_MS < 13 * 60 * 60 * 1000,
    `${PHOTO_REQUEST_TTL_MS}ms`,
  );

  for (const locale of LOCALES) {
    const t = getCatalog(locale).whatsapp;
    const title = 'Pintura do 2.º andar';
    const ask = t.checkinPhotoAsk(title);
    const next = t.checkinPhotoNext(title);
    check(`${locale}: the photo ask names the task`, ask.includes(title), ask);
    check(`${locale}: the follow-up names the next task`, next.includes(title), next);
    check(`${locale}: neither leaks undefined`, !`${ask}${next}`.includes('undefined'));
    check(
      `${locale}: all three photo strings are distinct`,
      new Set([ask, next, t.checkinPhotoThanks]).size === 3,
    );
    // Each is one free-form WhatsApp message following an acknowledgement that
    // has already been sent.
    for (const [name, body] of [['ask', ask], ['next', next], ['thanks', t.checkinPhotoThanks]] as const) {
      check(
        `${locale}: the photo ${name} fits one WhatsApp message`,
        body.length > 0 && body.length <= 300,
        `${body.length} chars`,
      );
    }
    // ⚠ THE ONE RULE EVERY ACKNOWLEDGEMENT ON THIS PATH SHARES. The claim is
    // waiting for the manager; a worker told the task is finished who then sees
    // it on tomorrow's 07:00 message concludes Capo is broken.
    check(
      `${locale}: the photo thanks does not claim the task is done`,
      t.checkinPhotoThanks !== t.checkinDone,
      t.checkinPhotoThanks,
    );
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

// ── delivery statuses (issue #51, B4) ───────────────────────────────────────
// THE THIRD SHAPE, and the one that was silently discarded for the whole life
// of the product: a status arrives on `field: 'messages'` with `statuses` and
// NO `messages`, so the old router flat-mapped an absent array and found
// nothing. That is why notification_log.status = 'sent' could only ever mean
// "Meta accepted it".
const delivered = routeWebhookChanges<Fixture>(
  changes({
    field: 'messages',
    value: {
      statuses: [
        { id: 'wamid.A', status: 'delivered', timestamp: '1755100000', recipient_id: waId },
        { id: 'wamid.B', status: 'read', timestamp: '1755100060' },
        {
          id: 'wamid.C',
          status: 'failed',
          timestamp: '1755100120',
          errors: [{ code: 132001, title: 'Template name does not exist in the translation' }],
        },
      ],
    },
  }),
);
eq('a statuses-only change yields ZERO messages', delivered.messages.length, 0);
eq('and is NOT reported as an unhandled field', delivered.unhandledFields.length, 0);
eq('all three statuses are read', delivered.statuses.length, 3);
eq('the wamid is carried', delivered.statuses[0]?.id, 'wamid.A');
eq('the state is carried', delivered.statuses[0]?.state, 'delivered');
eq('the timestamp parses from Meta’s string seconds', delivered.statuses[0]?.timestamp, 1755100000);
eq('a failure carries its code', delivered.statuses[2]?.errorCode, 132001);
check(
  'and its title, for the raw line next to the plain-language one',
  (delivered.statuses[2]?.errorTitle ?? '').startsWith('Template name'),
  String(delivered.statuses[2]?.errorTitle),
);

// A batch really does mix a person writing with receipts for messages we sent,
// and one must never cost the other.
const withBoth = routeWebhookChanges<Fixture>(
  changes({
    field: 'messages',
    value: {
      messages: [{ id: 'wamid.in' }],
      statuses: [{ id: 'wamid.out', status: 'sent', timestamp: '1755100000' }],
    },
  }),
);
eq('a mixed messages/statuses change keeps the message', withBoth.messages.length, 1);
eq('and the status', withBoth.statuses.length, 1);

// The compatibility branch has to cover statuses too, or a payload with no
// `field` and only statuses would be reported as a surprise rather than
// recorded.
const fieldlessStatus = routeWebhookChanges<Fixture>(
  changes({ value: { statuses: [{ id: 'wamid.D', status: 'read', timestamp: '1' }] } }),
);
eq('a field-less statuses change is still read', fieldlessStatus.statuses.length, 1);
eq('and is not reported as unhandled', fieldlessStatus.unhandledFields.length, 0);

// Counted, never dropped — same reasoning as unreadableRotations. A status we
// silently discard is a delivery the product then claims never happened.
const badStatuses = routeWebhookChanges<Fixture>(
  changes({
    field: 'messages',
    value: {
      statuses: [
        { status: 'delivered' }, // no id
        { id: 'wamid.E', status: 'accepted' }, // not a state we know
        null,
      ],
    },
  }),
);
eq('an unreadable status is not invented', badStatuses.statuses.length, 0);
eq('and all three are counted', badStatuses.unreadableStatuses, 3);

// An unparseable timestamp must NOT make the status vanish; the applier falls
// back to its own clock, because a delivery whose second we cannot read is
// still a delivery.
const noStamp = routeWebhookChanges<Fixture>(
  changes({ field: 'messages', value: { statuses: [{ id: 'wamid.F', status: 'delivered' }] } }),
);
eq('a status with no timestamp survives', noStamp.statuses.length, 1);
eq('with a null timestamp rather than a guess', noStamp.statuses[0]?.timestamp, null);

// ── Meta's numeric codes, pulled back out of our own prose ──────────────────
// notification_log.error stores describeSendError(err), which is a
// WhatsAppSendError message. The screen has to render "the template is not
// approved for this language yet" rather than a wall of English, and that
// needs the code back.
eq(
  'the code is recovered from a stored send error',
  readMetaErrorCode('WhatsApp send failed (400, code 132001): Template name does not exist'),
  132001,
);
eq(
  'the allow-list code from the old test tier still reads',
  readMetaErrorCode('WhatsApp send failed (400, code 131030): recipient not in allowed list'),
  131030,
);
eq('a message with no code yields null', readMetaErrorCode('fetch failed'), null);
eq('and so does an absent error', readMetaErrorCode(null), null);
eq(
  'a bare status line is not mistaken for a code',
  readMetaErrorCode('WhatsApp send failed (503): upstream unavailable'),
  null,
);

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
      // The default is the pre-#44 world: one person, in charge. Every
      // assertion around it therefore still describes exactly the message that
      // went out before collaborators existed.
      role: 'lead',
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

  // ── THE CREW DAY LINK (issue #114) ────────────────────────────────────────
  //
  // The CTA is free-form ONLY: toTemplateParam flattens whitespace and
  // capo_daily_briefing is pinned to {{1}}/{{2}} with no button component, both
  // of which this file already asserts elsewhere. What is checked here is the
  // half that can regress silently — that the link survives the character cap.
  const LINK = 'https://www.construcapo.com/dia?t=' + 'k'.repeat(43);

  const withLink = renderWorkerFreeForm(briefing([task()]), { dayLinkUrl: LINK });
  check('the CTA carries the URL', withLink.includes(LINK), withLink);
  check('and a sentence above it', withLink.includes('Vê a tua lista completa'), withLink);
  check(
    'the URL is on its own line, so WhatsApp gives it the whole tap target',
    withLink.split('\n').includes(LINK),
    JSON.stringify(withLink.slice(-120)),
  );
  check(
    'and the CTA is LAST — the work comes first, the control surface after it',
    withLink.trimEnd().endsWith(LINK),
    JSON.stringify(withLink.slice(-80)),
  );

  // Absent by default. mintDayLinks swallows its own failures, so "no link"
  // must render exactly the message this function rendered before #114.
  eq('no link means the message is unchanged', renderWorkerFreeForm(briefing([task()])), one);

  // A worker with nothing on still gets the link: "nothing today" is precisely
  // when somebody wants to check for themselves.
  check(
    'an idle day still carries the link',
    renderWorkerFreeForm(briefing([]), { dayLinkUrl: LINK }).includes(LINK),
    'missing',
  );

  // ⚠ THE REGRESSION THIS EXISTS FOR. The CTA is reserved from the character
  // budget BEFORE the blocks are laid out. Appended after the clamp instead, a
  // rich day would truncate the URL into a dead string — a link that looks like
  // a link, goes nowhere, and only ever does so for the busiest people on the
  // crew, who are the least likely to report it.
  const pathologicalWithLink = renderWorkerFreeForm(
    briefing(
      Array.from({ length: 5 }, (_, i) =>
        task({
          title: `${'T'.repeat(400)} ${i}`,
          description: 'd'.repeat(1000),
          materials: Array.from({ length: 30 }, () => 'm'.repeat(200)),
        }),
      ),
    ),
    { dayLinkUrl: LINK },
  );
  check(
    'a pathological briefing still carries an INTACT link',
    pathologicalWithLink.includes(LINK),
    'the URL was truncated by the cap',
  );
  check(
    'and still fits one WhatsApp message',
    pathologicalWithLink.length <= 4000,
    `${pathologicalWithLink.length} chars`,
  );
  eq('so it is still never split', splitForWhatsApp(pathologicalWithLink).length, 1);

  for (const locale of LOCALES) {
    const body = renderWorkerFreeForm({ ...briefing([task()]), locale }, { dayLinkUrl: LINK });
    check(`${locale} — the CTA renders`, body.includes(LINK), body);
    check(`${locale} — and leaks no undefined`, !body.includes('undefined'), body);
  }
}

// ── TWO PEOPLE ON ONE TASK (issue #44) ──────────────────────────────────────
//
// Federico's complaint, verbatim: "there is no way for Capo to assign 2 people
// to the same task. What it does instead it duplicates the task, duplicating
// the amount of material needed."
//
// So there are two things to prove here and they are of different kinds.
//
//   1. THE MATERIALS ARE NOT MULTIPLIED. Structural, and asserted against the
//      REAL loadCompanyBriefing over a fake Db — the same device the crew
//      partition checks use — because a re-implementation of the fan-out here
//      would keep passing after somebody rewrote the real one.
//   2. A COLLABORATOR IS NEVER TOLD THE JOB IS THEIRS. Copy, and the reason
//      this feature can be actively harmful if it ships half-done: two people
//      each believing they are in charge is worse than the duplicate task it
//      replaces.
{
  const LEAD = '11111111-1111-4111-8111-111111111111';
  const HELPER = '22222222-2222-4222-8222-222222222222';

  // ONE task_board row, exactly as the view returns it after 0035: one
  // `materials` array, one address, one set of collaborator columns.
  const boardRow = {
    id: uuid,
    company_id: 'co',
    title: 'Pintar tecto',
    job_name: 'Casa de Paco',
    job_address: 'Rua das Flores 12',
    status: 'pending',
    is_open: true,
    active_today: true,
    overdue: false,
    days_overdue: 0,
    description: 'Duas demãos.',
    materials: ['tinta 10L', 'rolo', 'fita'],
    depends_on_titles: [],
    due_date: '2026-08-20',
    assignee_worker_id: LEAD,
    worker_name: 'Miguel',
    collaborator_worker_ids: [HELPER],
    collaborator_names: ['João'],
  };
  const optedIn = '2026-08-01T10:00:00Z';
  const crew = [
    { id: LEAD, name: 'Miguel', active: true, phone: '351911111111', whatsapp_opt_in_at: optedIn },
    { id: HELPER, name: 'João', active: true, phone: '351922222222', whatsapp_opt_in_at: optedIn },
  ];

  const fanned = await loadCompanyBriefing(
    fakeBriefingDb({ task_board: [boardRow], workers: crew }),
    'co',
    'pt-PT',
  );

  const lead = fanned.workers.find(w => w.workerId === LEAD);
  const helper = fanned.workers.find(w => w.workerId === HELPER);
  check('both people on the task get a briefing', !!lead && !!helper);
  eq('the lead is briefed about it', lead?.tasks.length, 1);
  eq('and so is the collaborator', helper?.tasks.length, 1);
  eq('the lead is told they lead it', lead?.tasks[0]?.role, 'lead');
  eq('the collaborator is told they are helping', helper?.tasks[0]?.role, 'collaborator');
  eq('and who they are helping', helper?.tasks[0]?.lead_name, 'Miguel');
  eq('the lead is told who is with them', lead?.tasks[0]?.collaborator_names?.join(','), 'João');

  // ── THE PROOF THE ISSUE ASKS FOR ──────────────────────────────────────────
  // It is ONE task. Two people read it; there is one id, and one materials
  // list, whose contents are identical on both sides. The old workaround —
  // two tasks — would show two ids here and two `materials` arrays, and
  // /materiais would add them together.
  const allTaskIds = new Set(fanned.workers.flatMap(w => w.tasks.map(t => t.id)));
  eq('two people, ONE task id between them', allTaskIds.size, 1);
  eq(
    'and the collaborator sees the SAME material list, not a second one',
    helper?.tasks[0]?.materials.join('|'),
    lead?.tasks[0]?.materials.join('|'),
  );
  eq('which is exactly what is on the task', lead?.tasks[0]?.materials.join('|'), 'tinta 10L|rolo|fita');
  // The manager's own count is a ROW count and must not move either — it is
  // what the 07:00 thread note and the manager's template both quote.
  eq("the manager's 'today' count still says one task", fanned.counts.today, 1);

  // ── the wording, in every language ────────────────────────────────────────
  for (const locale of LOCALES) {
    const t = getCatalog(locale).reminders;
    const helperBody = renderWorkerFreeForm({ ...helper!, locale });
    const leadBody = renderWorkerFreeForm({ ...lead!, locale });

    check(`${locale} — the helper is told whose job it is`, helperBody.includes('Miguel'), helperBody);
    check(
      `${locale} — using the collaborator wording, not the plain title`,
      helperBody.includes(t.taskAsCollaborator('Pintar tecto (Casa de Paco)', 'Miguel')),
      helperBody,
    );
    check(`${locale} — and leaks no undefined`, !helperBody.includes('undefined'), helperBody);
    // Same address, same materials. A helper who is told less than the lead has
    // to phone somebody, which is the failure #49 already fixed once.
    check(`${locale} — the helper still gets the address`, helperBody.includes('Rua das Flores 12'), helperBody);
    check(`${locale} — and the same materials`, helperBody.includes('tinta 10L'), helperBody);

    check(`${locale} — the lead is told who is with them`, leadBody.includes(t.freeFormWith('João')), leadBody);
    // ⚠ The asymmetry that keeps the message readable: only the LEAD gets the
    // "with you" line. Telling a helper who their fellow helpers are pushes the
    // address further down a phone screen at 07:00.
    check(
      `${locale} — the helper is NOT given a "with you" list`,
      !helperBody.includes(t.freeFormWith('')),
      helperBody,
    );
    // And the lead's own line is unchanged from before this feature: no role
    // clause, because they are the assignee and always were.
    check(
      `${locale} — the lead's headline gains no role clause`,
      leadBody.includes(t.taskWithJob('Pintar tecto', 'Casa de Paco')),
      leadBody,
    );
  }

  // Lateness stays LAST on the line, after the role clause: it is the thing
  // that changes what somebody does first, and burying it mid-sentence is the
  // one ordering mistake that costs a day.
  {
    const t = getCatalog('pt-PT').reminders;
    const late = renderWorkerFreeForm({
      ...helper!,
      tasks: [{ ...helper!.tasks[0]!, overdue: true, days_overdue: 3 }],
    });
    check('an overdue helper task names the lead', late.includes('a ajudar Miguel'), late);
    check('and still marks the delay', late.includes('3'), late);
    check(
      'with the delay after the role, not before it',
      late.indexOf('a ajudar Miguel') < late.indexOf(t.taskOverdue('', 3).trim().slice(0, 4)),
      late,
    );
  }

  // A task whose assignee was cleared while helpers stayed on it. Reachable —
  // clearing the assignee deliberately does not delete anybody's row — and the
  // copy must claim nothing about anybody rather than printing "a ajudar null".
  {
    const orphaned = renderWorkerFreeForm({
      ...helper!,
      tasks: [{ ...helper!.tasks[0]!, lead_name: null }],
    });
    check(
      'a helper on a lead-less task is told it is a team job',
      orphaned.includes(getCatalog('pt-PT').reminders.taskAsTeam('Pintar tecto (Casa de Paco)')),
      orphaned,
    );
    check('and never reads "null" or "undefined"', !/null|undefined/.test(orphaned), orphaned);
  }

  // The one-line TEMPLATE parameter carries the role clause too. It is the
  // envelope a crew member OUTSIDE the free 24h window gets, i.e. the one that
  // reaches somebody who has never written to Capo — the person most likely to
  // misread whose job it is.
  {
    const [, list] = renderWorkerBriefing(helper!);
    check('the paid template also names the lead', list.includes('a ajudar Miguel'), list);
    check('and stays one line', !list.includes('\n'), JSON.stringify(list));
  }

  // A task with NO collaborators is byte-identical to what it rendered before
  // this feature. That is what makes shipping it a no-op for every existing
  // crew on the morning it lands.
  {
    const solo = await loadCompanyBriefing(
      fakeBriefingDb({
        task_board: [{ ...boardRow, collaborator_worker_ids: [], collaborator_names: [] }],
        workers: crew,
      }),
      'co',
      'pt-PT',
    );
    eq('a task with no helpers reaches only its assignee', solo.workers.filter(w => w.tasks.length > 0).length, 1);
    const body = renderWorkerFreeForm(solo.workers.find(w => w.workerId === LEAD)!);
    check('and its message carries no "with you" line', !body.includes('Contigo'), body);
  }

  // THE DEPLOY-ORDERING CASE. 0035 APPENDS the two columns to task_board, so a
  // deploy that lands before its migration reads `undefined` for both. That
  // must brief exactly the people it briefs today rather than throwing — every
  // task_board reader uses select('*') for this reason (AGENTS.md).
  {
    const { collaborator_worker_ids: _a, collaborator_names: _b, ...preMigration } = boardRow;
    const degraded = await loadCompanyBriefing(
      fakeBriefingDb({ task_board: [preMigration], workers: crew }),
      'co',
      'pt-PT',
    );
    eq('a pre-migration row still briefs the assignee', degraded.workers.find(w => w.workerId === LEAD)?.tasks.length, 1);
    eq('and briefs nobody else', degraded.workers.find(w => w.workerId === HELPER)?.tasks.length, 0);
  }

  // And the guard against a view whose two aggregates stopped agreeing: naming
  // the wrong person to their own crew is worse than naming nobody.
  {
    const misaligned = await loadCompanyBriefing(
      fakeBriefingDb({
        task_board: [{ ...boardRow, collaborator_names: [] }],
        workers: crew,
      }),
      'co',
      'pt-PT',
    );
    eq(
      'mismatched collaborator arrays name nobody rather than guessing',
      misaligned.workers.find(w => w.workerId === HELPER)?.tasks.length,
      0,
    );
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
  // capo_task_checkin is answered by tapping, capo_welcome_v2 offers one
  // "Say hi"; capo_daily_briefing is answered with free text (PT/ES/EN/STOP).
  // Declaring a button component on a send whose approved template has none
  // earns a 132000 on every send, so a stray BUTTONS block here would take the
  // whole 07:00 briefing down — and the reverse is worse than it looks: Meta
  // accepts a send that OMITS the component for a template that declares one
  // and echoes the button's own LABEL back as the payload, so the tap comes
  // back unparseable.
  //
  // An ALLOWLIST rather than a single name, grown deliberately: adding a
  // template here is a decision, and the default for anything not named stays
  // "no buttons".
  const BUTTONED_TEMPLATES = ['capo_task_checkin', 'capo_welcome_v2'];
  const buttonComponent = def.components.find(c => c.type === 'BUTTONS') as
    | { buttons: { type: string; text: string }[] }
    | undefined;
  if (!BUTTONED_TEMPLATES.includes(def.name)) {
    check(`${label} — declares no buttons`, buttonComponent === undefined);
    continue;
  }

  const buttons = buttonComponent!.buttons;
  check(`${label} — every button is a quick reply`, buttons.every(b => b.type === 'QUICK_REPLY'));
  for (const b of buttons) {
    check(`${label} — "${b.text}" is 1..25 chars`, b.text.length >= 1 && b.text.length <= 25, `${b.text.length}`);
    // Meta refuses a quick-reply label carrying an emoji, a variable, a newline
    // or any formatted character — error_subcode 2388060 at SUBMISSION time,
    // which is the one failure this repo cannot see until somebody runs
    // `pnpm whatsapp-template create` and reads Spanish error prose. It cost
    // capo_welcome_v2 the waving hand it was written with.
    check(`${label} — "${b.text}" carries no emoji`, !/\p{Extended_Pictographic}/u.test(b.text), b.text);
    check(`${label} — "${b.text}" is one plain line`, !/[\n\t]|\{\{/.test(b.text), b.text);
  }

  if (def.name === 'capo_welcome_v2') {
    // ONE button, and it must stay one. The check-in's two buttons are an
    // ANSWER whose ORDER is a contract; this one carries a single payload with
    // no id, so there is nothing to invert — a second button here would
    // silently acquire that contract without the comments that police it.
    eq(`${label} — exactly one button`, buttons.length, 1);
    // Meta caps a quick-reply label at 25 and an interactive reply-button
    // TITLE at 20, and this same label rides both envelopes (the approved
    // template and the free-form twin's reply button). Held to the tighter of
    // the two, so the free-form copy is never the truncated one.
    check(
      `${label} — the label fits an interactive reply button too`,
      buttons[0].text.length <= 20,
      `${buttons[0].text.length}`,
    );
    eq(`${label} — the label is the catalog's`, buttons[0].text, getCatalog(locale!).reminders.welcomeButton);
    continue;
  }

  eq(`${label} — exactly two buttons`, buttons.length, 2);
  // The labels must be the catalog's, in done-then-notDone order — the same
  // order /api/cron/checkin mints payloads in.
  const t = getCatalog(locale!).whatsapp;
  eq(`${label} — button 0 is the done label`, buttons[0].text, t.checkinDoneButton);
  eq(`${label} — button 1 is the not-done label`, buttons[1].text, t.checkinNotDoneButton);
  check(`${label} — labels differ`, buttons[0].text !== buttons[1].text);
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

// THE regression guard for defect 1 (a card must be delivered, not dropped) and
// for "a card travels alone": the manager gets ONE message for one decision.
// The trailing prose these three fixtures drop is the "Got a card up for that,
// boss — tap approve and you're set" second notification.
const interleaved = planAssistantMessages([text('antes'), card('Crear tarea: «x».'), text('depois')], labels);
eq('a card turn is exactly one message', interleaved.length, 1);
eq('and that message is the card', interleaved[0]?.kind, 'interactive');
eq('the card body is the rendered text', interleaved[0]?.body, 'Crear tarea: «x».');

// Prose BEFORE the card goes too — which is why the planner has to know a card
// is coming before it walks the parts, rather than discovering it in order.
const leading = planAssistantMessages([text('antes'), card('Crear tarea: «x».')], labels);
eq('prose ahead of a card is dropped as well', leading.length, 1);
eq('leaving only the card', leading[0]?.kind, 'interactive');

// Two cards in one turn: both survive, the prose around them does not.
const twoCards = planAssistantMessages(
  [text('antes'), card('Crear tarea: «a».', uuid), text('meio'), card('Crear tarea: «b».', uuid2), text('depois')],
  labels,
);
eq('every card in the turn is delivered', twoCards.length, 2);
check('and nothing but cards', twoCards.every(m => m.kind === 'interactive'));

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

// The over-limit branch emits `kind: 'text'` for the CARD's own words. That is
// card content, not commentary, so it survives "a card travels alone" — while
// the model's prose in the same turn still does not.
const bigWithProse = planAssistantMessages([text('antes'), card('L'.repeat(2000)), text('depois')], labels);
eq('an over-limit card still becomes text + interactive', bigWithProse.length, 2);
eq('the card text survives (it is the card, not commentary)', bigWithProse[0]?.body, 'L'.repeat(2000));
eq('and the buttons follow', bigWithProse[1]?.kind, 'interactive');

// Meta's hard limits, asserted across every fixture.
const all = [...interleaved, ...leading, ...twoCards, ...short, ...literal, ...big, ...huge, ...bigWithProse];
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

// THE auto-do path, pinned. A write the guard let through returns
// `status: 'executed'` — not a card — so the manager gets the model's one-line
// "done, boss" and nothing else. Silencing that would leave a change to a live
// job with no trace in the conversation at all.
const executed = planAssistantMessages(
  [toolOutput({ status: 'executed', result: { id: uuid } }), text('Feito, chefe. Demolição para o Zé, prazo sexta.')],
  labels,
);
eq('an executed write still gets its confirmation', executed.length, 1);
eq('and it is the model\'s own line', executed[0]?.body, 'Feito, chefe. Demolição para o Zé, prazo sexta.');

// The old sink returned early when there was no text, swallowing the card.
const silent = planAssistantMessages([card('Crear tarea: «x».')], labels);
eq('a card with no prose is still delivered', silent.length, 1);

// Prose is converted AND THEN flattened on the way out.
//
// This assertion used to expect `*Casa de Paco*`, and the change is deliberate
// (header note 13): converting `**` to WhatsApp's single-asterisk bold fixed
// the literal asterisks a manager used to read, but bold on WhatsApp is itself
// a tell, because nobody emphasises a word when texting a builder.
//
// The conversion step is NOT redundant now that the emphasis is stripped. It is
// what makes stripping cheap: by the time the voice pass runs, every markdown
// dialect the model might have emitted has been collapsed into one canonical
// form, so flattening it is three regexes instead of a second converter.
const converted = planAssistantMessages([text('Obra creada: **Casa de Paco**.')], labels);
eq('prose is markdown-converted and then flattened', converted[0]?.body, 'Obra creada: Casa de Paco.');

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

  // Same change, same reason, and the two must stay identical: there is no
  // reading of this channel on which bold is right for the manager and wrong
  // for a crew member.
  const converted = planWorkerMessages([text('Precisas de **primário** e rolo.')]);
  eq('worker prose is converted and flattened too', converted[0]?.body, 'Precisas de primário e rolo.');

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
//      keeps them apart — only the fact that the id prefixes are pairwise
//      non-overlapping, so each of those six directions is asserted below.
//      There are now FIVE shapes: capo:hi (the welcome's "Say hi") is asserted
//      in the same block, and capo:photos: (0047) further down beside the photo
//      inbox, together with the directions between those two.
//  16. Three keyword tables now sit in front of the worker agent, and they must
//      stay disjoint. The one that must never move is `es`: a bare "ES" has to
//      keep resolving to Spanish with ZERO model calls, and a collision would
//      route it to a menu or an opt-out instead, cheerfully.
//  17. Meta's interactive-list limits are enforced by clamping (cosmetic) and
//      throwing (structural). The body cap is deliberately the conservative
//      figure — Meta's own page and every third-party summary disagree — because
//      being wrong upward is a 400 at 07:00 and a crew that hears nothing.

// ── the id codecs, pairwise ─────────────────────────────────────────────────
// The three original shapes and the welcome's capo:hi are asserted here; the
// fifth, capo:photos: (0047), is asserted against all of them in its own block
// below rather than here, so the photo inbox's checks stay in one place.
// Between the two blocks all FIVE codecs are covered in every direction.
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

  // ── the FOURTH codec: the welcome's "Say hi" (issue #45 follow-up) ────────
  // It arrives under BOTH `type: 'button'` (the template envelope) and
  // `type: 'interactive'` (the free-form twin's reply button), so it has to be
  // disjoint from three shapes rather than two — and one of those, the check-in,
  // shares its envelope field exactly.
  const hi = hiPayload();
  check('the hi payload round-trips', isHiPayload(hi));
  check('and is case-insensitive, like the other three', isHiPayload('CAPO:HI'));
  // It carries NO id, for workerMenuRowId('manager')'s reason: nothing can be
  // looked up from it, so nothing can leak through it.
  check('the hi payload carries no uuid', !hi.includes(uuid), hi);
  check('and nothing else parses as it', !isHiPayload(''));
  check('a foreign prefix is not a hi', !isHiPayload('evil:hi'));
  // A PREFIX match would accept every other codec, since all four start
  // 'capo:'. Exact whole-string is what makes the six directions below hold.
  check('a longer string starting with it is not a hi', !isHiPayload(`${hi}:${uuid}`));

  eq('a hi is not a check-in payload', parseCheckinPayload(hi), null);
  eq('a hi is not a proposal id', parseProposalButtonId(hi), null);
  eq('a hi is not a menu row', parseWorkerMenuRowId(hi), null);
  check('a check-in payload is not a hi', !isHiPayload(checkin));
  check('a proposal id is not a hi', !isHiPayload(approve));
  check('a menu task row is not a hi', !isHiPayload(menuTask));
  check('the menu manager row is not a hi', !isHiPayload(menuManager));

  // ── THE TWO ENVELOPES, which is the claim the whole button rests on ──────
  // The welcome goes out as an approved TEMPLATE (the tap returns
  // `type: 'button'` with `button.payload`) and, inside the free 24-hour
  // window, as an interactive reply-buttons message (the tap returns
  // `type: 'interactive'` with `interactive.button_reply.id`). isHiTap is the
  // whole of what maps those two shapes onto one fact, and the failure of
  // EITHER half is silent: the other envelope goes on working, so the button
  // simply stops answering for one population of recipients.
  check('a template quick reply is a hi tap', isHiTap({ type: 'button', button: { payload: hi } }));
  check(
    'an interactive reply button is the same hi tap',
    isHiTap({ type: 'interactive', interactive: { button_reply: { id: hi } } }),
  );
  check('and case does not matter on either', isHiTap({ type: 'button', button: { payload: 'CAPO:HI' } }));
  // The envelope FIELD is part of the shape: a payload on the wrong field is
  // not a hi, or a check-in tap could be read as one by a future edit that
  // stopped looking at `type`.
  check('a payload on the interactive field is not a button tap', !isHiTap({ type: 'button', interactive: { button_reply: { id: hi } } }));
  check('an id on the button field is not an interactive tap', !isHiTap({ type: 'interactive', button: { payload: hi } }));
  // Everything else must fall through, or a hello would swallow a real message.
  check('a text message is not a hi tap', !isHiTap({ type: 'text' }));
  check('an empty envelope is not a hi tap', !isHiTap({}));
  check('a check-in tap is not a hi tap', !isHiTap({ type: 'button', button: { payload: checkin } }));
  check(
    'a menu tap is not a hi tap',
    !isHiTap({ type: 'interactive', interactive: { button_reply: { id: menuTask } } }),
  );
  check(
    "a manager's approval tap is not a hi tap",
    !isHiTap({ type: 'interactive', interactive: { button_reply: { id: approve } } }),
  );
}

// ── the keyword tables in front of the agent ────────────────────────────────
{
  const tables: [string, Iterable<string>][] = [
    ['language', Object.keys(LANGUAGE_KEYWORDS)],
    ['opt-out', OPT_OUT_KEYWORDS],
    ['opt-in', OPT_IN_KEYWORDS],
    ['menu', MENU_KEYWORDS],
    // Issue #120 — the report table, the only one both sender kinds
    // consult; issue #108 — the detail table, the knock's reply. Every pair
    // including both is asserted below like the others, which is what proves
    // "ok" can never file a report and "bug" can never fetch the day.
    ['detail', DETAIL_KEYWORDS],
    ['report', REPORT_KEYWORDS],
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

  // ── the FOURTH table: the knock's answer (issue #108) ─────────────────────
  // "Responde OK para veres o detalhe" is a promise the paid template makes;
  // this table is what keeps it. Whole-message, case- and whitespace-
  // insensitive, zero model calls — and the punctuated forms are members of
  // the SET, not a stripped match, so the discipline stays identical to the
  // other three tables.
  eq('a bare OK summons the full briefing', detailCommand('OK'), true);
  eq('and is case- and whitespace-insensitive', detailCommand('  ok  '), true);
  eq('a thumb-typed "Ok." works too', detailCommand('Ok.'), true);
  eq('and "ok!"', detailCommand('ok!'), true);
  eq('DETALHE works in all three languages', `${detailCommand('detalhe')}/${detailCommand('detalle')}/${detailCommand('details')}`, 'true/true/true');
  eq('a sentence starting with ok is not a request', detailCommand('ok, e o material?'), false);
  eq('an empty message asks for nothing', detailCommand(''), false);
  eq('and neither does undefined', detailCommand(undefined), false);
  // None of the older tables may claim the trained word — the knock teaches
  // every crew member that OK means "show me my day", and a collision would
  // silently reroute it.
  eq('the menu never claims ok', menuCommand('ok'), false);
  eq('nor does the language table', languageCommand('ok'), null);
  eq('nor does consent', consentCommand('ok'), null);
  // Words that read as REPORTING A PROBLEM must never be answered with a task
  // list. Reserved here so no future edit to this table can quietly take them:
  // a worker saying "problema" is telling us something is wrong, and the wrong
  // answer is a cheerful briefing.
  for (const word of ['bug', 'problema', 'erro', 'problem', 'error', 'fallo']) {
    check(`the detail table never claims "${word}"`, !DETAIL_KEYWORDS.has(word), word);
  }
}

// ── "report a problem" (issue #120) ─────────────────────────────────────────
// The fourth keyword table, and the ONE deliberate break with the
// whole-message rule: a keyword as the FIRST WORD files the rest of the same
// message immediately ("bug o menu não abre"), because a report split across
// two messages is a report half of which never arrives. Every behaviour of
// that exception is pinned here, because the exception is exactly where a
// future edit would quietly widen the match into reading sentences as
// commands.
{
  eq('a bare "bug" arms the two-message flow', reportCommand('bug')?.kind, 'arm');
  eq('case- and whitespace-insensitive', reportCommand('  BUG  ')?.kind, 'arm');
  eq('a labelled bare keyword still arms ("problema:")', reportCommand('problema:')?.kind, 'arm');
  eq('all six words arm', ['bug', 'problema', 'erro', 'problem', 'error', 'fallo']
    .map(w => reportCommand(w)?.kind)
    .join(','), 'arm,arm,arm,arm,arm,arm');

  const inline = reportCommand('bug o menu não abre');
  eq('keyword-first files inline', inline?.kind, 'inline');
  eq('with the rest of the message as the report, verbatim',
    inline?.kind === 'inline' ? inline.text : null, 'o menu não abre');
  const labelled = reportCommand('erro: não recebo o resumo das 07:00');
  eq('a labelled inline report drops the label punctuation',
    labelled?.kind === 'inline' ? labelled.text : null, 'não recebo o resumo das 07:00');

  // The false-positive direction that must stay CLOSED: the keyword anywhere
  // but first is a sentence, not a command.
  eq('mid-sentence "bug" is not a report', reportCommand('o menu tem um bug'), null);
  eq('a sentence about a site problem does not start the flow', reportCommand('temos um problema na obra'), null);
  eq('an unrelated message is untouched', reportCommand('es que falta material'), null);
  eq('empty and undefined are no command', `${reportCommand('')}/${reportCommand(undefined)}`, 'null/null');

  // The other three tables never claim these words, and vice versa — the
  // disjointness loop above asserts every pair, but the two words most likely
  // to collide by future edit are pinned by name.
  eq('the menu never claims "bug"', menuCommand('bug'), false);
  eq('a bare ES is still Spanish, never a report', reportCommand('ES'), null);

  // The staging TTL (0042): enforced by the READER, nothing sweeps the table.
  eq('the request TTL is 30 minutes', REPORT_REQUEST_TTL_MS, 30 * 60 * 1000);
  const armedAt = Date.parse('2026-01-05T10:00:00Z');
  const expiry = reportRequestExpiry(armedAt);
  check('a request is live inside its TTL', reportRequestLive(expiry, armedAt + REPORT_REQUEST_TTL_MS - 1));
  check('and dead the moment it passes', !reportRequestLive(expiry, armedAt + REPORT_REQUEST_TTL_MS));
  check('an unparseable expires_at reads as expired', !reportRequestLive('not a date', armedAt));
  check('and so does a missing one', !reportRequestLive(null, armedAt));

  // The clamp mirrors the column CHECK (0042): a long report is truncated,
  // never refused — and counted in code points, so it can never exceed what
  // char_length() counts nor split a surrogate pair.
  eq('a short report passes through trimmed', clampReportText('  a lista duplica  '), 'a lista duplica');
  eq('a long report is clamped to the CHECK bound', [...clampReportText('x'.repeat(REPORT_TEXT_MAX + 500))].length, REPORT_TEXT_MAX);
  eq('emoji count as one, matching char_length()', [...clampReportText('📷'.repeat(REPORT_TEXT_MAX + 5))].length, REPORT_TEXT_MAX);
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
      // The default is the pre-#44 world: one person, in charge. Every
      // assertion around it therefore still describes exactly the message that
      // went out before collaborators existed.
      role: 'lead',
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

// ── the KNOCK and the v2 template it rides (issue #108) ─────────────────────
// The paid template's {{2}} is no longer the squashed task list: it states the
// size of the day and asks for a reply ("responde OK"), which the webhook
// answers with the full free-form briefing. Everything here is the pure half
// of that: the copy in three languages, the punctuation that only ever shows
// on a live send, the fact that the knock survives Meta's parameter rules, and
// the per-locale old-vs-v2 template switch.
{
  function task(over: Partial<BriefingTask> = {}): BriefingTask {
    return {
      id: uuid,
      title: 'Canalização',
      job_name: 'Casa de Paco',
      overdue: false,
      days_overdue: 0,
      description: null,
      materials: [],
      job_address: null,
      waiting_on: [],
      awaiting_review: false,
      due_date: null,
      role: 'lead',
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
  const threeTasks = [task(), task({ overdue: true, days_overdue: 2 }), task()];

  for (const locale of LOCALES) {
    const t = getCatalog(locale).reminders;

    // The copy itself, count-aware. The digit is not enough — the NOUN must
    // change too, so replacing the digit in the singular must not produce the
    // plural sentence.
    const oneTask = t.workerKnock({ count: 1, overdue: 0 });
    const twoTasks = t.workerKnock({ count: 2, overdue: 0 });
    check(`${locale} — the knock counts one task`, oneTask.includes('1'), oneTask);
    check(`${locale} — and two`, twoTasks.includes('2'), twoTasks);
    check(`${locale} — with a real plural, not just a digit swap`, oneTask.replace('1', '2') !== twoTasks, `${oneTask} / ${twoTasks}`);

    // Lateness is a clause, present exactly when there is something late.
    const calm = t.workerKnock({ count: 3, overdue: 0 });
    const late = t.workerKnock({ count: 3, overdue: 1 });
    check(`${locale} — a late day reads differently`, calm !== late, late);
    check(`${locale} — and names how many are late`, late.includes('1'), late);

    // ⚠ The punctuation rule languageHint already follows, for the same
    // reason: the OLD template body continues "…{{2}}. Responde STOP…", so a
    // trailing stop renders as ".." on a live send and nowhere else.
    check(`${locale} — the knock carries no trailing full stop`, !/[.。]$/.test(late), late);

    // A template parameter is one flat line. If toTemplateParam has to CHANGE
    // the knock, the copy contains something Meta would have rejected.
    eq(`${locale} — the knock needs no flattening`, toTemplateParam(late), late);
    check(`${locale} — and is newline-free`, !/[\n\t]/.test(late), late);

    // The renderer around it: the same hint and zero-task mechanics as the
    // task-list renderer, through the same helper — an idle worker's message
    // and a first-contact worker's language line must not depend on which
    // renderer the route reached for.
    const [knockName, knock] = renderWorkerKnock(briefing({ locale, tasks: threeTasks }));
    eq(`${locale} — the knock renderer names the worker`, knockName, 'Miguel');
    check(`${locale} — and counts the day`, knock.includes('3'), knock);
    check(`${locale} — including the late ones`, knock.includes('1'), knock);
    const [, hinted] = renderWorkerKnock(briefing({ locale, tasks: threeTasks }), { languageHint: true });
    check(`${locale} — the hint appends on request`, hinted.endsWith(t.languageHint), hinted);
    check(`${locale} — and never by default`, !knock.includes(t.languageHint), knock);
    check(`${locale} — with no doubled full stop`, !hinted.includes('..'), hinted);
    eq(
      `${locale} — a worker with nothing today reads exactly what the old renderer said`,
      renderWorkerKnock(briefing({ locale, tasks: [] }), { languageHint: true })[1],
      renderWorkerBriefing(briefing({ locale, tasks: [] }), { languageHint: true })[1],
    );

    // The knock composed into BOTH live bodies — the v2 it was written for and
    // the old one it rides until every locale is approved. '..' anywhere in
    // the composition is the failure that only ever shows on a live send.
    for (const name of ['capo_daily_briefing', 'capo_daily_briefing_v2']) {
      const def = allTemplates().find(d => d.name === name && d.language === t.templateLanguage)!;
      check(`${locale} — ${name} exists for this locale`, !!def);
      const bodyText = String((def.components.find(c => c.type === 'BODY') as { text?: string } | undefined)?.text ?? '');
      const composed = bodyText.replace('{{1}}', 'Miguel').replace('{{2}}', hinted);
      check(`${locale} — the knock reads cleanly inside ${name}`, !composed.includes('..'), composed);
      check(`${locale} — and arrives intact`, composed.includes(knock), composed);
    }

    // The v2 body's whole point is the layout: {{2}} on its own paragraph,
    // no language line (#49's lesson — any re-approval must not reintroduce
    // it), the opt-out still stated, and literal text at both ends (Meta
    // rejects a body that begins or ends with a parameter).
    const v2 = allTemplates().find(d => d.name === 'capo_daily_briefing_v2' && d.language === t.templateLanguage)!;
    const v2Body = String((v2.components.find(c => c.type === 'BODY') as { text?: string } | undefined)?.text ?? '');
    check(`${locale} — v2 gives {{2}} its own paragraph`, /\n\n\{\{2\}\}\n\n/.test(v2Body), JSON.stringify(v2Body));
    check(`${locale} — v2 never offers PT/ES/EN`, !/\bPT\b/.test(v2Body), v2Body);
    check(`${locale} — v2 still states the opt-out`, /STOP/i.test(v2Body), v2Body);
    check(`${locale} — v2 starts and ends with literal text`, !v2Body.startsWith('{{') && !v2Body.endsWith('}}'), v2Body);
  }

  // ── the per-locale template switch ──────────────────────────────────────
  // A hand-maintained mirror of Meta's approval state (see the module's own
  // comment for why it is not a Graph API lookup). What is assertable here:
  // the matrix as of 2026-09-01, and the fail-safe direction — anything not
  // explicitly approved falls to the OLD name, which all three locales have.
  eq('pt_PT sends the v2 template', briefingTemplateFor('pt_PT'), 'capo_daily_briefing_v2');
  eq('en_US sends the v2 template', briefingTemplateFor('en_US'), 'capo_daily_briefing_v2');
  eq('es_ES moved to v2 once Meta approved it (2026-09-03)', briefingTemplateFor('es_ES'), 'capo_daily_briefing_v2');
  eq('an unknown locale falls back to the old template', briefingTemplateFor('fr_FR'), 'capo_daily_briefing');
  for (const language of BRIEFING_V2_APPROVED_LANGUAGES) {
    check(`approved code ${language} is one this repo submits`, TEMPLATE_LANGUAGES.includes(language), language);
    check(
      `and has a v2 definition to diff against Meta`,
      allTemplates().some(d => d.name === 'capo_daily_briefing_v2' && d.language === language),
      language,
    );
  }

  // ── the OK reply's loader, through the real function ──────────────────────
  // loadWorkerBriefing must fan out exactly what loadCompanyBriefing fans out
  // — same filter, same roles — or the knock's promise ("reply OK to see the
  // detail") is answered with a different day than the morning message
  // described. Driven against the fake Db, like the loaders above.
  {
    const LEAD = '11111111-1111-4111-8111-111111111111';
    const HELPER = '22222222-2222-4222-8222-222222222222';
    const board = [
      // On today, briefable: the row both loaders must fan out.
      { id: uuid, title: 'Pintar tecto', job_name: 'Casa de Paco', status: 'pending', is_open: true, active_today: true, assignee_worker_id: LEAD, worker_name: 'Miguel', collaborator_worker_ids: [HELPER], collaborator_names: ['João'], materials: ['tinta 10L'] },
      // Declared finished — BRIEFABLE excludes it, so the OK reply must not
      // nag about it either (the same reason the two daily sends do not).
      { id: '33333333-3333-4333-8333-333333333333', title: 'Rebocar', status: 'pending_review', is_open: true, active_today: true, assignee_worker_id: LEAD },
      // Not on today at all.
      { id: '44444444-4444-4444-8444-444444444444', title: 'Amanhã', status: 'pending', is_open: true, active_today: false, assignee_worker_id: LEAD },
    ];
    const args = { companyId: 'co', name: 'Miguel', recipient: { kind: 'phone', waId } as const, locale: 'pt-PT' as const, hasChosenLanguage: false };

    const lead = await loadWorkerBriefing(fakeBriefingDb({ task_board: board }), { ...args, workerId: LEAD });
    eq('the OK reply carries exactly the briefable-today tasks', lead.tasks.length, 1);
    eq('as the lead', lead.tasks[0]?.role, 'lead');
    check('a task in review is not nagged about', !lead.tasks.some(t => t.id.startsWith('3333')), JSON.stringify(lead.tasks.map(t => t.title)));

    const helper = await loadWorkerBriefing(fakeBriefingDb({ task_board: board }), { ...args, workerId: HELPER, name: 'João' });
    eq('a helper gets the task too', helper.tasks.length, 1);
    eq('told they are helping', helper.tasks[0]?.role, 'collaborator');
    eq('and by whom', helper.tasks[0]?.lead_name, 'Miguel');
    // The knock's promised detail is the SAME renderer the 07:00 free-form
    // send uses, so this body is asserted to carry the role wording that #44
    // made a requirement.
    const helperBody = renderWorkerFreeForm(helper);
    check(
      'the OK reply tells a helper whose job it is',
      helperBody.includes(getCatalog('pt-PT').reminders.taskAsCollaborator('Pintar tecto (Casa de Paco)', 'Miguel')),
      helperBody,
    );
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

  // The prefilled text must survive the round trip intact in EVERY locale —
  // accents, punctuation, and the '?' that ends all three greetings.
  for (const locale of LOCALES) {
    const prefill = getCatalog(locale).whatsappHandshake.prefill;
    const url = new URL(buildWhatsAppLink(NUMBER, prefill)!);
    eq(`${locale} — the prefilled text round-trips through the link`, url.searchParams.get('text'), prefill);
    check(`${locale} — the prefill is not empty`, prefill.trim().length > 0, prefill);
  }

  // Three languages, three different messages. A copy-paste that left two
  // locales identical would be invisible in review and wrong in production.
  const prefills = LOCALES.map(l => getCatalog(l).whatsappHandshake.prefill);
  check('handshake — all three prefills differ', new Set(prefills).size === LOCALES.length, prefills.join(' | '));
}

// ── the desktop QR code (issue #84) ─────────────────────────────────────────
// A QR that encodes the wrong thing, or nothing, looks exactly like a QR that
// works. Nobody reviewing a screenshot can tell. These assertions are the only
// thing standing between a broken code and a manager pointing a camera at it.
{
  const link = buildWhatsAppLink('+351911097383', getCatalog('pt-PT').whatsappHandshake.prefill)!;
  const qr = qrGeometry(link);

  // Every QR version is 4n+17 modules square (21, 25, … 177). A count outside
  // that family means the encoder was misused, not that the link is long.
  check('qr — the module count is a real QR version', (qr.count - 17) % 4 === 0 && qr.count >= 21 && qr.count <= 177, String(qr.count));
  check('qr — the path is not empty', qr.path.length > 0);
  check('qr — the path is only SVG path commands', /^[Mmhvz0-9 .-]+$/.test(qr.path), qr.path.slice(0, 40));

  // The 4-module quiet zone is required by the QR spec, not decoration: many
  // scanners will not lock on without it. Baking it into viewBox is what stops
  // a caller from forgetting it.
  check('qr — the viewBox carries the 4-module quiet zone', qr.viewBox === `-4 -4 ${qr.count + 8} ${qr.count + 8}`, qr.viewBox);

  // Deterministic: the page is force-dynamic and re-renders per request, so a
  // non-deterministic encoder would hand two managers different codes for the
  // same link and make any bug here unreproducible.
  // check(), not eq(): eq()'s detail string JSON.stringifies both sides and
  // prints it on PASS as well as FAIL, and a QR path is ~50KB of SVG
  // coordinates. Printed twice per run, it drowned out every other line in
  // this file's output — this repo's only correctness signal.
  check('qr — the same text yields the same path', qrGeometry(link).path === qr.path);
  check('qr — different text yields a different path', qrGeometry(`${link}x`).path !== qr.path);
}

// ── the welcome (issue #45) ─────────────────────────────────────────────────
//
// The first message Capo ever sends somebody, once per person, ever. Three
// things here are load-bearing and none of them fails loudly in production:
//
//   a. It is a PROACTIVE send, so it may only ever reach somebody with a
//      recorded opt-in. The audience loader must therefore drop exactly the
//      people the two daily sends drop, and for exactly the same reasons —
//      which is why it goes through partitionCrew rather than a filter of its
//      own.
//   b. It has TWO envelopes — the paid template and, for anybody inside their
//      24-hour window, free text. The approved template body is BUILT from the
//      same two catalog strings the free-form renderer uses, so the two cannot
//      drift into introducing Capo differently depending on an invisible
//      property of the recipient. Assert the rejoin, the way cache-check
//      asserts the system-prompt split.
//   c. Both parameters go into a Meta template, where a newline is a 132000
//      that fails the whole send. A company name and a person's name are both
//      manager-authored free text.
{
  const optedIn = '2026-08-01T10:00:00Z';

  // The kinds must stay distinct. 'welcome' is the only one locked once-EVER
  // (0033's partial unique index); collapsing it into either daily kind would
  // either welcome people daily or stop a daily send after its first day.
  check('the welcome kind is its own', WELCOME_KIND === 'welcome');
  check('and is neither daily kind', WELCOME_KIND !== 'daily_briefing' && WELCOME_KIND !== 'task_checkin');

  const crew = [
    // welcomable: active, reachable, consenting, never welcomed
    { id: 'w1', name: 'Zé', active: true, phone: '351911111111', whatsapp_opt_in_at: optedIn },
    // consented, but ALREADY welcomed — the steady state, and the one the
    // ledger read exists to keep cheap
    { id: 'w2', name: 'Pepe', active: true, phone: '351922222222', whatsapp_opt_in_at: optedIn },
    // ⚠ THE ONE THAT MATTERS. Reachable, active, and nobody has agreed on their
    // behalf. A welcome to this person is the message that gets a business
    // number banned.
    { id: 'w3', name: 'Ana', active: true, phone: '351933333333', whatsapp_opt_in_at: null },
    // consenting but with nowhere to send
    { id: 'w4', name: 'Rui', active: true, phone: null, whatsapp_opt_in_at: optedIn },
    // switched off
    { id: 'w5', name: 'Antigo', active: false, phone: '351955555555', whatsapp_opt_in_at: optedIn },
    // ── #121's four retry cases, all consenting and reachable ──
    // failed yesterday on a retryable code — the pilot's exact shape
    { id: 'w6', name: 'Tó', active: true, phone: '351966666601', whatsapp_opt_in_at: optedIn },
    // failed TODAY — one paid attempt per Lisbon day
    { id: 'w7', name: 'Nuno', active: true, phone: '351966666602', whatsapp_opt_in_at: optedIn },
    // failed on a permanent code — a number that is not on WhatsApp
    { id: 'w8', name: 'Ivo', active: true, phone: '351966666603', whatsapp_opt_in_at: optedIn },
    // failed three times — the cap is spent
    { id: 'w9', name: 'Gil', active: true, phone: '351966666604', whatsapp_opt_in_at: optedIn },
  ];
  const managers = [
    { id: 'p1', full_name: 'Federico', language: 'pt-PT', phone: '+5491178876189', whatsapp_opt_in_at: optedIn },
    // the account holder who never ticked the box on /perfil. Being the owner
    // is not consent to be messaged on WhatsApp.
    { id: 'p2', full_name: 'Sócio', language: 'pt-PT', phone: '+351966666666', whatsapp_opt_in_at: null },
  ];
  const today = '2026-08-31';
  const failed132001 = (date: string) => ({
    status: 'failed',
    error: `WhatsApp send failed (404, code 132001): template name (capo_welcome) does not exist in pt_PT`,
    notification_date: date,
  });
  const done = [
    { worker_id: 'w2', profile_id: null, status: 'sent', error: null, notification_date: '2026-08-20' },
    { worker_id: 'w6', profile_id: null, ...failed132001('2026-08-30') },
    { worker_id: 'w7', profile_id: null, ...failed132001(today) },
    {
      worker_id: 'w8',
      profile_id: null,
      status: 'failed',
      error: 'WhatsApp send failed (400, code 131026): Message Undeliverable',
      notification_date: '2026-08-30',
    },
    { worker_id: 'w9', profile_id: null, ...failed132001('2026-08-27') },
    { worker_id: 'w9', profile_id: null, ...failed132001('2026-08-28') },
    { worker_id: 'w9', profile_id: null, ...failed132001('2026-08-29') },
  ];

  const audience = await loadPendingWelcomes(
    fakeBriefingDb({ workers: crew, profiles: managers, notification_log: done }),
    { id: 'co', name: 'Construções Silva', language: 'pt-PT' },
    today,
  );

  const ids = audience.pending.map(p => p.id).sort();
  eq('only the never-welcomed, consenting, reachable people are pending', ids.join(','), 'p1,w1,w6');
  check('a worker with no recorded opt-in is NEVER pending', !ids.includes('w3'));
  check('a manager with no recorded opt-in is NEVER pending either', !ids.includes('p2'));
  check('an already-welcomed worker is not welcomed twice', !ids.includes('w2'));
  // #121: the retry policy applied through the real loader, not just the pure
  // function — one person per rule.
  check('a failed welcome from yesterday, on a retryable code, IS pending again', ids.includes('w6'));
  check('a failure from TODAY is not retried until tomorrow', !ids.includes('w7'));
  check('a permanent failure is never retried', !ids.includes('w8'));
  check('a spent attempt cap is final', !ids.includes('w9'));
  eq('the consent exclusion is counted, not silent', audience.excludedNoConsent, 1);
  eq('and so is the unreachable one', audience.excludedUnreachable, 1);
  eq('and the inactive one', audience.excludedInactive, 1);
  eq('and the manager one', audience.excludedManagers, 1);
  eq('and the not-retried failures are too', audience.excludedFailed, 3);
  eq('only truly blocking rows count as already welcomed', audience.alreadyWelcomed, 1);

  const worker = audience.pending.find(p => p.id === 'w1')!;
  const manager = audience.pending.find(p => p.id === 'p1')!;
  eq('a crew member is addressed as a worker', worker.audience, 'worker');
  eq('a profile is addressed as a manager', manager.audience, 'manager');

  // WHO ADDED THEM. The account owner's name opens the crew sentence, and it is
  // read off the SAME ordered profiles list the ledger uses rather than a
  // second query. `.order('created_at')` is ascending, so the newest NAMED
  // profile wins — 'Sócio' here, who joined after Federico.
  eq('the welcome names the most recently created manager', audience.managerName, 'Sócio');
  eq(
    'a company with no named profile answers null rather than a placeholder',
    (
      await loadPendingWelcomes(
        fakeBriefingDb({ workers: [], profiles: [{ id: 'p9', full_name: '   ', language: 'pt-PT', phone: null, whatsapp_opt_in_at: null }], notification_log: [] }),
        { id: 'co2', name: 'Sem Nome', language: 'pt-PT' },
        today,
      )
    ).managerName,
    null,
  );

  for (const locale of LOCALES) {
    const t2 = getCatalog(locale).reminders;
    const target = { ...worker, locale };
    const [name, middle] = renderWelcome(target, 'Construções Silva', 'João');
    const [, managerMiddle] = renderWelcome({ ...manager, locale }, 'Construções Silva', 'João');
    const [, anonymous] = renderWelcome(target, 'Construções Silva', null);

    // ── the opening clause (the immediate-welcome work) ───────────────────
    // It is what makes the first message land as a real thing a real person
    // did, rather than as software introducing itself, so it must come FIRST:
    // that is the sentence a crew member reads in the notification preview.
    check(`${locale} — the crew welcome names who added them`, middle.includes('João'), middle);
    check(`${locale} — and does so before anything else`, middle.indexOf('João') < 40, middle);
    // The null is a REAL case (no profile yet, or a blank full_name) and the
    // clause is OMITTED rather than filled with a placeholder naming nobody.
    check(`${locale} — with no manager on file the clause simply goes`, !anonymous.includes('João'), anonymous);
    check(`${locale} — and the company is still named`, anonymous.includes('Construções Silva'), anonymous);
    check(`${locale} — and nothing leaks`, !/undefined|null|,\s*,/.test(anonymous), anonymous);
    eq(`${locale} — the anonymous sentence still needs no flattening`, toTemplateParam(anonymous), anonymous);
    // A pasted paragraph in a manager's full_name must not blow {{2}} apart
    // either — it is manager-authored free text on exactly the same road as
    // the company name.
    const [, messyManager] = renderWelcome(target, 'Construções Silva', 'João\nSilva\tPereira dos Santos e Filhos, Lda, encarregado geral');
    eq(`${locale} — a multi-line manager name is flattened`, toTemplateParam(messyManager), messyManager);

    // (c) Template parameters survive Meta's rules untouched. If toTemplateParam
    // has to CHANGE either of them, the copy contains something Meta would have
    // rejected outright.
    eq(`${locale} — the name parameter needs no flattening`, toTemplateParam(name), name);
    eq(`${locale} — the worker sentence needs no flattening`, toTemplateParam(middle), middle);
    eq(`${locale} — the manager sentence needs no flattening`, toTemplateParam(managerMiddle), managerMiddle);

    // The two audiences must actually differ. One approved template serving
    // both is only defensible because {{2}} carries the difference.
    check(`${locale} — worker and manager are told different things`, middle !== managerMiddle, middle);
    check(`${locale} — the welcome names the company`, middle.includes('Construções Silva'), middle);

    // A welcome is by definition first contact, so this is the one message
    // where the language options are certainly new information (#49 made them
    // conditional everywhere else).
    check(`${locale} — the crew welcome offers PT/ES/EN`, /\bPT\b/.test(middle), middle);
    check(`${locale} — the manager welcome does not`, !/\bPT,/.test(managerMiddle), managerMiddle);

    // (b) THE REJOIN. The approved template body is greeting ⊕ {{2}} ⊕ opt-out,
    // and the free-form twin is the same three strings with newlines between
    // them. Assert against the REAL template definition rather than a
    // re-derivation, so a change to either side fails here.
    const def = allTemplates().find(d => d.name === 'capo_welcome' && d.language === t2.templateLanguage)!;
    const body = (def.components.find(c => c.type === 'BODY') as { text: string }).text;
    const freeForm = renderWelcomeFreeForm(target, 'Construções Silva', 'João');
    eq(
      `${locale} — the free-form welcome is the template body, rejoined`,
      freeForm.replace(/\n+/g, ' '),
      body.replace('{{1}}', name).replace('{{2}}', middle),
    );
    // Meta expects a utility message to say how to stop receiving them, and the
    // free-form path has no approved wrapper to say it on our behalf.
    check(`${locale} — the free-form welcome still states the opt-out`, freeForm.includes(t2.welcomeStop), freeForm);
    check(`${locale} — and leaks no undefined`, !freeForm.includes('undefined'), freeForm);
  }

  // ── capo_welcome_v2 is capo_welcome plus a button, and nothing else ──────
  // The body was already right, so v2 re-uses it byte for byte. Asserting the
  // equality is what stops a change to the welcome's wording landing on one
  // name and not the other — which would mean two crew members in the same
  // company reading two different introductions depending on which locale Meta
  // had got round to approving.
  for (const language of TEMPLATE_LANGUAGES) {
    const v1 = allTemplates().find(d => d.name === 'capo_welcome' && d.language === language)!;
    const v2 = allTemplates().find(d => d.name === 'capo_welcome_v2' && d.language === language)!;
    eq(
      `${language} — capo_welcome_v2's body is capo_welcome's, byte for byte`,
      (v2.components.find(c => c.type === 'BODY') as { text: string }).text,
      (v1.components.find(c => c.type === 'BODY') as { text: string }).text,
    );
  }

  // ── the approval gate (briefing-template.ts's shape, and its reasoning) ──
  // Meta approves per name+language pair, so naming an unapproved template is a
  // 132001 refusal and a person who hears nothing. The gate and the BUTTON must
  // move together: a button component against capo_welcome (which declares
  // none) is a 132000 on every send, and no button component against
  // capo_welcome_v2 makes Meta echo the LABEL back as the payload, so the tap
  // parses as nothing. One call returns both, which is what makes that
  // impossible to get half right.
  for (const language of TEMPLATE_LANGUAGES) {
    const chosen = welcomeTemplateFor(language);
    eq(
      `${language} — the chosen welcome template matches the approval set`,
      chosen.name,
      WELCOME_V2_APPROVED_LANGUAGES.has(language) ? 'capo_welcome_v2' : 'capo_welcome',
    );
    eq(`${language} — the button rides v2 and only v2`, chosen.hasButton, chosen.name === 'capo_welcome_v2');
  }
  eq('an unknown locale code falls back to the approved-everywhere template', welcomeTemplateFor('de_DE').name, 'capo_welcome');
  check('and carries no button with it', !welcomeTemplateFor('de_DE').hasButton);

  // A pasted paragraph in the company name must not blow the parameter apart.
  const [, messy] = renderWelcome({ ...worker, locale: 'pt-PT' }, 'Obras\nSilva\t& Filhos, Lda, a maior empresa de construção civil de toda a região norte de Portugal');
  eq('a multi-line company name is flattened before it reaches Meta', toTemplateParam(messy), messy);
  check('and clamped rather than allowed to run on', messy.includes('…'), messy);

  // ── THE OPERATOR'S RESEND MUST SAY THE SAME THING ───────────────────────
  // apps/operator's "resend a failed welcome" button renders the message a
  // second time, because apps may not import each other's modules. Its own
  // comment claims it is "built from the same catalog keys renderWelcome uses",
  // and this is the only thing that can keep that claim true: the population it
  // serves is, by definition, people whose FIRST welcome failed, so a drift
  // here means the coldest wording reaching the people who have had the worst
  // experience of Capo so far.
  //
  // WHICH manager is named is NOT duplicated — pickAccountOwnerName in
  // @capo/db is one rule with two callers, and it is pinned below.
  for (const locale of LOCALES) {
    const t3 = getCatalog(locale).reminders;
    for (const audience of ['worker', 'manager'] as const) {
      const [name, middle] = renderWelcome(
        { ...worker, audience, name: 'Miguel', locale },
        'Construções Silva',
        'João',
      );
      const plan = planWelcomeResend({
        audience,
        personName: 'Miguel',
        companyName: 'Construções Silva',
        managerName: 'João',
        locale,
      });
      eq(`${locale} ${audience} — the resend's {{1}} is the sweep's`, plan.bodyParams[0], name);
      eq(`${locale} ${audience} — the resend's {{2}} is the sweep's`, plan.bodyParams[1], middle);
      eq(`${locale} ${audience} — and it goes out in this person's language`, plan.languageCode, t3.templateLanguage);
    }
    // The null case has to travel too: a resend for a company with no readable
    // owner name omits the clause rather than rendering a placeholder.
    const [, anonymousResend] = planWelcomeResend({
      audience: 'worker',
      personName: 'Miguel',
      companyName: 'Construções Silva',
      managerName: null,
      locale,
    }).bodyParams;
    const [, anonymousSweep] = renderWelcome({ ...worker, locale }, 'Construções Silva', null);
    eq(`${locale} — and the no-manager wording matches too`, anonymousResend, anonymousSweep);
    // ⚠ The resend stays on the BUTTON-LESS template on purpose: giving it
    // capo_welcome_v2 would put a second copy of the approval gate in the
    // operator app, whose failure mode is a 132000 on every resend.
    eq(
      `${locale} — a resend uses the button-less template`,
      planWelcomeResend({ audience: 'worker', personName: 'Miguel', companyName: 'X', managerName: null, locale })
        .templateName,
      'capo_welcome',
    );
  }

  // ── THE EMPTY-DAY ANSWER MUST NOT SAY THE SAME THING TWICE ──────────────
  // A crew member who taps "Olá!" with nothing scheduled reads two sentences:
  // reminders.workerNothing ("Nada agendado para hoje.") from the shared
  // briefing renderer, then whatsapp.hiWorkerMorning. This is the FIRST thing
  // Capo ever writes to them, and it shipped repeating itself in the first
  // three lines — exactly the machine tell voice-check exists to remove, and
  // invisible to voice-check because neither sentence is wrong on its own.
  for (const locale of LOCALES) {
    const nothing = getCatalog(locale).reminders.workerNothing;
    const morning = getCatalog(locale).whatsapp.hiWorkerMorning;
    check(`${locale} — the 07:00 line does not repeat "nothing scheduled"`, !morning.includes(nothing), morning);
    check(`${locale} — nor the other way round`, !nothing.includes(morning), nothing);
    // What it IS for: saying when the next message arrives, so an empty first
    // answer does not read as "this thing does nothing".
    check(`${locale} — and it names the hour the day arrives`, /7/.test(morning), morning);
  }

  // ── WHO GETS NAMED: one rule, two apps (packages/db/src/account-owner.ts) ──
  // Ordered created_at ASCENDING, so the newest NAMED row wins. Every branch is
  // asserted because the two failures are opposite and both silent: the wrong
  // colleague's name, or a placeholder where a name should be.
  eq(
    'the newest named profile is the one credited',
    pickAccountOwnerName([{ full_name: 'Velho' }, { full_name: 'Novo' }]),
    'Novo',
  );
  eq(
    'a newer profile with no name does not blank out an older one',
    pickAccountOwnerName([{ full_name: 'Federico' }, { full_name: null }, { full_name: '   ' }]),
    'Federico',
  );
  eq('no profiles at all is null, not a placeholder', pickAccountOwnerName([]), null);
  eq('and neither is a company whose only names are blank', pickAccountOwnerName([{ full_name: ' ' }]), null);

  // The thread note (issue #47's boundary, one more source). Crew names only,
  // and they are text the MANAGER typed.
  for (const locale of LOCALES) {
    const note = renderWelcomeEvent(2, ['Zé', 'Pepe'], locale);
    check(`${locale} — the welcome thread note names who was introduced`, note.includes('Zé') && note.includes('Pepe'), note);
    check(`${locale} — and leaks no undefined`, !note.includes('undefined'), note);
  }
}

// ── the welcome retry policy (issue #121) ───────────────────────────────────
//
// 0041 narrows the once-ever lock so a FAILED welcome releases its claim, and
// these three rules — an error allowlist, an attempt cap, one attempt per
// Lisbon day — are all that stands between that and a repeating paid send.
// They live in apps/web/lib/welcome-retry.ts, pure, so every branch is pinned
// here. The posture under test is FAIL CLOSED: every ambiguity — an unknown
// code, a code-less error, an undatable row, an unreadable status — must
// resolve toward NOT paying for another template.
{
  eq(
    '132001 — template missing in a locale — is retryable (the pilot case)',
    classifyWelcomeError('WhatsApp send failed (404, code 132001): template name (capo_welcome) does not exist in pt_PT'),
    'retryable',
  );
  eq(
    '130429 — rate limited — is retryable',
    classifyWelcomeError('WhatsApp send failed (400, code 130429): Rate limit hit'),
    'retryable',
  );
  eq(
    '131026 — undeliverable recipient — is permanent',
    classifyWelcomeError('WhatsApp send failed (400, code 131026): Message Undeliverable'),
    'permanent',
  );
  eq(
    'a code-less failure is permanent — unknown must not earn a paid loop',
    classifyWelcomeError('WhatsApp send failed (503): upstream unavailable'),
    'permanent',
  );
  eq('an unparseable error is permanent', classifyWelcomeError('fetch failed'), 'permanent');
  eq('an absent error is permanent', classifyWelcomeError(null), 'permanent');

  // Three attempts, ever. The failed rows ARE the counter, one per Lisbon day
  // by 0016's daily unique key — so the constant is also the number of days a
  // broken config gets before somebody has to intervene by hand.
  eq('the attempt cap is three', WELCOME_MAX_ATTEMPTS, 3);

  const today = '2026-08-31';
  const failed = (date: string | null, code = 132001) => ({
    status: 'failed',
    error: `WhatsApp send failed (400, code ${code}): x`,
    notification_date: date,
  });

  eq('no history — never attempted', decideWelcomeRetry([], today), 'never_attempted');
  eq(
    'a sent row blocks forever',
    decideWelcomeRetry([{ status: 'sent', error: null, notification_date: '2026-08-01' }], today),
    'blocked',
  );
  eq(
    'a skipped row blocks forever — 0033 backfill rows stay untouchable',
    decideWelcomeRetry([{ status: 'skipped', error: null, notification_date: '2026-08-01' }], today),
    'blocked',
  );
  eq(
    'a pending row blocks — a claim in flight is not a failure',
    decideWelcomeRetry([failed('2026-08-30'), { status: 'pending', error: null, notification_date: today }], today),
    'blocked',
  );
  eq(
    'a row with no readable status blocks — fail closed',
    decideWelcomeRetry([{ notification_date: '2026-08-01' }], today),
    'blocked',
  );
  eq('yesterday, retryable, first attempt — retry', decideWelcomeRetry([failed('2026-08-30')], today), 'retry');
  eq('a failure from TODAY cools down — one paid attempt per Lisbon day', decideWelcomeRetry([failed(today)], today), 'cooldown');
  eq(
    'a future-dated failure cools down too — a weird clock must not fail open',
    decideWelcomeRetry([failed('2027-01-01')], today),
    'cooldown',
  );
  eq('an undatable failure cools down', decideWelcomeRetry([failed(null)], today), 'cooldown');
  eq(
    'the NEWEST failure governs: retryable after permanent — retry',
    decideWelcomeRetry([failed('2026-08-29', 131026), failed('2026-08-30', 132001)], today),
    'retry',
  );
  eq(
    'and permanent after retryable — permanent',
    decideWelcomeRetry([failed('2026-08-29', 132001), failed('2026-08-30', 131026)], today),
    'permanent',
  );
  eq(
    'three failures — exhausted, whatever the codes say',
    decideWelcomeRetry([failed('2026-08-27'), failed('2026-08-28'), failed('2026-08-29')], today),
    'exhausted',
  );
}

// ── the voice pass (human tone) ─────────────────────────────────────────────
//
// See header note 13. The em dash is the anchor case because it is the one tell
// that is unarguable: producing one on a phone keyboard takes a long press, so
// its presence in a WhatsApp message is close to proof that no human typed it.
{
  const DASH = /[\u2012\u2013\u2014\u2015]/;

  // ── the pure function ────────────────────────────────────────────────────
  const parenthetical = applyWhatsAppVoice('A demolição — que começa segunda — está atrasada.');
  eq(
    'a parenthetical pair becomes commas, not full stops',
    parenthetical.text,
    'A demolição, que começa segunda, está atrasada.',
  );
  eq('and it is reported', parenthetical.repairs[0]?.rule, 'em_dash');

  eq('a numeric range becomes a hyphen', applyWhatsAppVoice('Leva 10—12 dias.').text, 'Leva 10-12 dias.');
  eq(
    'a line-leading dash is a bullet marker, not punctuation',
    applyWhatsAppVoice('Hoje:\n— pintar\n— azulejo').text,
    'Hoje:\npintar\nazulejo',
  );
  eq(
    'formatting is flattened, not converted',
    applyWhatsAppVoice('*Casa de Paco*\n\n- demolição\n- pintura').text,
    'Casa de Paco\n\ndemolição\npintura',
  );
  eq('the first emoji survives', applyWhatsAppVoice('Pronto 👍 já está 🎉 tudo 🚀').text, 'Pronto 👍 já está tudo');
  eq(
    'an assistant reflex is cut, in Portuguese as well as English',
    applyWhatsAppVoice('Tarefa criada. Estou aqui para ajudar.').text,
    'Tarefa criada.',
  );
  check('clean prose is returned untouched', applyWhatsAppVoice('Feito, chefe.').repairs.length === 0);

  // Required property, exactly as for toWhatsAppMarkdown: the sink must be safe
  // to run over already-converted text. It holds by construction here, because
  // every rule REMOVES a shape rather than adding one, but "by construction" is
  // what people say right before it stops being true.
  const twice = ['A obra — Casa de Paco — 10—12 dias.', '*a* — b 👍 🎉', '— um\n— dois'];
  check(
    'f(f(x)) === f(x)',
    twice.every(t => applyWhatsAppVoice(applyWhatsAppVoice(t).text).text === applyWhatsAppVoice(t).text),
  );

  // The channel-agnostic half keeps formatting, which is what would let the
  // in-app chat adopt it: there markdown is RENDERED, so flattening it would be
  // a downgrade rather than a fix.
  eq('applyVoice leaves markup alone', applyVoice('*Casa* — pronto').text, '*Casa*, pronto');

  // ── the seams ────────────────────────────────────────────────────────────
  const dashy = 'Feito, chefe — a demolição fica para sexta.';

  const managerOut = planAssistantMessages([text(dashy)], labels);
  check('no long dash reaches the manager', !DASH.test(managerOut[0]?.body ?? ''));
  eq('and the prose is repaired, not dropped', managerOut[0]?.body, 'Feito, chefe, a demolição fica para sexta.');

  const workerOut = planWorkerMessages([text(dashy)]);
  eq('the crew path gets the identical treatment', workerOut[0]?.body, managerOut[0]?.body);

  // THE scope assertion, and the reason this section exists at all. A card's
  // renderedText is hand-authored by cards/*.ts and may quote a worker's own
  // note; softening a dash inside it would silently desynchronise WhatsApp from
  // the row the web card and the operator app read.
  const cardText = 'Crear tarea: «Pintar» — obra Casa de Paco — 10—12 días.';
  const carded = planAssistantMessages([card(cardText)], labels);
  eq('an approval card is NOT voiced', carded[0]?.body, cardText);
  check('so a card may still carry a long dash', DASH.test(carded[0]?.body ?? ''));

  // ...including on the over-1024 branch, where the card travels as plain text
  // and would otherwise look exactly like prose to the flush path.
  const bigCard = 'Q'.repeat(1100) + ' — final.';
  const bigCarded = planAssistantMessages([card(bigCard)], labels);
  check('nor on the text branch of an over-limit card', DASH.test(bigCarded[0]?.body ?? ''));

  // ── the reporter ─────────────────────────────────────────────────────────
  // Optional BY DESIGN: omitted, these two stay pure, which is the whole reason
  // this file can assert them with no credentials and no network.
  const seen: VoiceRepair[] = [];
  planAssistantMessages([text('*Feito* — pronto 👍 🎉')], labels, r => seen.push(...r));
  eq(
    'every rule that fired is reported',
    seen.map(r => r.rule).sort().join(','),
    'em_dash,emoji_cap,flatten_formatting',
  );
  check('and each carries a sentence, not a code', seen.every(r => r.detail.length > 20));

  const silent: VoiceRepair[] = [];
  planWorkerMessages([text('Tudo certo, chefe.')], r => silent.push(...r));
  check('a clean turn reports nothing', silent.length === 0);
}

// ── crew requests: urgency is a DATE, and the thread note carries no quote ──
//
// Issue #152. Two things are pinned here and they are different in kind.
//
// The FIRST is the arithmetic. The whole feature turns on urgency being derived
// from `needed_by` minus lisbon_today() rather than from a model's reading of
// tone, and getting it wrong is silent in both directions: too high cries wolf
// until the manager stops looking, too low buries the one that mattered.
// `describeUrgency` is pure — `today` arrives as a string — so every branch,
// including the DST-transition days that would break a naive hour-based diff,
// is assertable with no credentials.
//
// The SECOND is a SAFETY boundary, and it is the reason this section exists at
// all. A request carries the crew member's own words, and two envelopes go out
// about it: a WhatsApp line to the manager's phone, which MAY quote them, and a
// `role='event'` row in `messages`, which may NOT — that table is what
// thread.recentUserTexts reads, and those last three user rows are the evidence
// pool runGuarded matches a manager's quote against before executing a
// manager-level write directly (0027, AGENTS.md). Same assertion shape as the
// check-in answer note above, for the same reason.
{
  const today = '2026-08-31';
  eq('needed_by today — "today"', describeUrgency('2026-08-31', today), 'today');
  eq('needed_by tomorrow — "tomorrow"', describeUrgency('2026-09-01', today), 'tomorrow');
  eq('needed_by next week — "later"', describeUrgency('2026-09-07', today), 'later');
  eq('needed_by yesterday — "overdue"', describeUrgency('2026-08-30', today), 'overdue');
  eq('no date — "undated", never a guess', describeUrgency(null, today), 'undated');
  eq('an empty date — "undated"', describeUrgency('', today), 'undated');
  eq('garbage — "undated", never a rank', describeUrgency('soon', today), 'undated');
  eq('no clock — "undated" rather than a wrong bucket', describeUrgency('2026-08-31', null), 'undated');

  // The two Lisbon DST transitions. A diff computed in local hours would make
  // one of these 23 hours and the other 25, so "amanhã" would round to today or
  // to the day after — on exactly two days a year, which is precisely the bug
  // nobody would ever reproduce. Both dates are parsed as UTC midnight, so the
  // difference is whole days by construction.
  eq('spring forward: 28 Mar → 29 Mar is still tomorrow', describeUrgency('2026-03-29', '2026-03-28'), 'tomorrow');
  eq('autumn back: 24 Oct → 25 Oct is still tomorrow', describeUrgency('2026-10-25', '2026-10-24'), 'tomorrow');

  // Ranking: the order Facu described, and undated LAST.
  const order: RequestUrgency[] = ['overdue', 'today', 'tomorrow', 'later', 'undated'];
  check(
    'ranking is overdue < today < tomorrow < later < undated',
    order.every((u, i) => i === 0 || urgencyRank(order[i - 1]!) < urgencyRank(u)),
  );
  check(
    'only overdue/today/tomorrow count as pressing',
    isPressing('overdue') && isPressing('today') && isPressing('tomorrow') &&
      !isPressing('later') && !isPressing('undated'),
  );

  const QUOTE = 'preciso de mais tinta na obra do Paco';
  for (const locale of LOCALES) {
    const message = renderRequestMessage(
      { workerName: 'Miguel', text: QUOTE, neededBy: '2026-09-01', taskTitle: 'Pintar tecto' },
      today,
      locale,
    );
    check(`${locale}: the WhatsApp line QUOTES the crew member verbatim`, message.includes(QUOTE));
    check(`${locale}: and names them`, message.includes('Miguel'));
    check(`${locale}: and says which day it is for`, message.includes(getCatalog(locale).requests.when({ kind: 'tomorrow', dateLabel: null })));

    // THE ONE THAT MATTERS. The thread note is our own copy around a crew name
    // the manager typed, a date and a task title — and nothing else. If this
    // ever fails, worker prose has reached `messages`.
    const note = renderRequestEvent(
      { workerName: 'Miguel', neededBy: '2026-09-01', taskTitle: 'Pintar tecto' },
      today,
      locale,
    );
    check(`${locale}: the THREAD NOTE never quotes the crew member`, !note.includes(QUOTE));
    check(`${locale}: the thread note still names who asked`, note.includes('Miguel'));
    check(`${locale}: the thread note still says when for`, note.includes(getCatalog(locale).requests.when({ kind: 'tomorrow', dateLabel: null })));

    // An undated request must read as a fact on both surfaces, not as an
    // absence: Capo asked once and did not guess, and the manager has to be
    // able to tell "no date" from "we forgot to say".
    const undated = renderRequestEvent({ workerName: 'Ana', neededBy: null, taskTitle: null }, today, locale);
    check(`${locale}: an undated request SAYS it is undated`, undated.includes(getCatalog(locale).requests.when({ kind: 'undated', dateLabel: null })));
  }
}

// ── the fifth crew tool's date guard (issue #152) ───────────────────────────
//
// `needed_by` is computed by the model from the date at the top of its prompt,
// and the one mistake with NO symptom is computing "amanhã" into the wrong
// YEAR: the request files as "later", never surfaces, and nobody finds out
// until the paint runs out. neededByIsSane is the refusal, and it is pure
// (`now` injected) so the band is pinned rather than assumed.
{
  const now = Date.parse('2026-08-31T00:00:00Z');
  check('tomorrow is sane', neededByIsSane('2026-09-01', now));
  check('yesterday is sane — "era para ontem" is a real request', neededByIsSane('2026-08-30', now));
  check('three months out is sane', neededByIsSane('2026-11-30', now));
  // The band exists for exactly this pair: a model computing "amanhã" into the
  // wrong year. Both must be refused, or the request files as "later" and is
  // never seen again.
  check('a year out is refused', !neededByIsSane('2027-09-01', now));
  check('a year back is refused', !neededByIsSane('2025-08-30', now));
  check('30 February is refused rather than rolled into March', !neededByIsSane('2026-02-30', now));
  check('a non-date is refused', !neededByIsSane('amanhã', now));
  check('a timestamp is refused — the column is a DAY', !neededByIsSane('2026-09-01T08:00:00Z', now));
}


// ── a crew member's voice note (W4) ─────────────────────────────────────────
//
// Until W4 an inbound `audio` message satisfied none of the gates in
// handleWorkerReply and fell to `workerAck`, the line written for a sticker.
// Crew on site talk far more than they type, so the channel's own audience was
// paying for a cost decision made about a path nobody had built yet.
//
// What is pinned here is the pure half: which messages are audio, what the
// size cap is, and when a transcript is not worth a model turn. The download
// and the Gemini call are not exercised - they need Meta and a model.
{
  check('a push-to-talk voice note is audio', isWorkerAudioMessage({ type: 'audio', audio: { id: 'm1', voice: true } }));
  // An uploaded m4a is accepted too, exactly as the manager path accepts one:
  // the two are indistinguishable to everything downstream, and refusing
  // somebody's own recording of themselves talking would be user-hostile.
  check('an uploaded audio file is audio too', isWorkerAudioMessage({ type: 'audio', audio: { id: 'm2', voice: false } }));
  // Meta can send an audio message with no media id. There is nothing to
  // download, so it must NOT reach the agent gate - it falls to workerAck.
  check('audio with no media id is not audio', !isWorkerAudioMessage({ type: 'audio' }));
  check('text is not audio', !isWorkerAudioMessage({ type: 'text' }));
  check('an image is not audio', !isWorkerAudioMessage({ type: 'image' }));
  check('a sticker is not audio, and still gets the ack', !isWorkerAudioMessage({ type: 'sticker' }));
  check('a document is not audio', !isWorkerAudioMessage({ type: 'document' }));

  // ONE cap, shared with the manager path rather than copied. Two numbers would
  // eventually disagree, and the symptom would be a crew member's voice note
  // refused at a size a manager's is accepted at, with nothing saying why.
  eq('the worker audio cap IS the manager audio cap', WORKER_AUDIO_MAX_BYTES, MAX_AUDIO_BYTES);
  check('and it sits under Meta\'s 16 MiB inbound ceiling', WORKER_AUDIO_MAX_BYTES < 16 * 1024 * 1024);

  // The emptiness rule. Gemini answers silence with an empty string, but a
  // noisy site recording can come back as one stray character, and both mean
  // the same thing to the person who recorded it.
  eq('an empty transcript is unusable', usableTranscript(''), null);
  eq('whitespace only is unusable', usableTranscript('   \n  '), null);
  eq('null is unusable', usableTranscript(null), null);
  eq('undefined is unusable', usableTranscript(undefined), null);
  eq('a single character is unusable', usableTranscript('a'), null);
  eq('punctuation alone is unusable', usableTranscript('...'), null);
  eq('a lone question mark is unusable', usableTranscript('?'), null);
  // A real short answer must survive: "ok" and "sim" are whole messages on a
  // building site, and refusing them would be the ack bug again in miniature.
  eq('"ok" is a real message', usableTranscript('ok'), 'ok');
  eq('"sim" is a real message', usableTranscript(' sim '), 'sim');
  eq('a sentence is trimmed, not altered', usableTranscript('  acabei a pintura  '), 'acabei a pintura');
  eq('the floor is two characters', MIN_WORKER_TRANSCRIPT_CHARS, 2);

  // ── ⚠ THE CONSEQUENCE, PINNED AT THE SEAM THAT CAUSES IT ──────────────────
  // Every deterministic keyword table is now reached through ONE function,
  // `keywordText`, and these assertions are over that function rather than over
  // the tables. That is the difference between testing the decision and merely
  // restating it: a future change that routed a transcript into the keyword
  // tables would have to make `keywordText` return something for a non-text
  // message, and the next three lines fail the moment it does.
  eq('a voice note yields NO keyword text', keywordText({ type: 'audio' }), undefined);
  eq('nor does a photo', keywordText({ type: 'image' }), undefined);
  eq('nor does a template button tap', keywordText({ type: 'button' }), undefined);
  eq('typed text does', keywordText({ type: 'text', text: { body: 'stop' } }), 'stop');

  // And the tables themselves are unchanged: a TYPED stop/menu/ES still
  // resolves with zero model calls, which is the half of the trade that must
  // never regress.
  check('the written STOP is still the unsubscribe', OPT_OUT_KEYWORDS.has('stop'));
  check('the written MENU is still the menu', MENU_KEYWORDS.has('menu'));
  check('the written ES is still the language switch', languageCommand('es') === 'es-ES');
  // The five commands read `keywordText`'s answer, so a voice note reaching
  // them is exactly as impossible as the four assertions above make it.
  eq('a spoken "stop" resolves to no consent command', consentCommand(keywordText({ type: 'audio' })), null);
  eq('a spoken "menu" resolves to no menu command', menuCommand(keywordText({ type: 'audio' })), false);
  eq('a spoken "ES" resolves to no language command', languageCommand(keywordText({ type: 'audio' })), null);
  eq('a spoken "ok" resolves to no detail command', detailCommand(keywordText({ type: 'audio' })), false);
  eq('a spoken "bug" resolves to no report command', reportCommand(keywordText({ type: 'audio' })), null);
}

// ── the worker path transcribes with NO company vocabulary ──────────────────
//
// The manager paths steer Gemini with up to 50 crew names, 50 obra names and 40
// learned terms for the tenant. That is their own data and it is the single
// biggest lever on accuracy. The WORKER path may not have it: the crew prompt
// is built around naming no other crew member, no other task and nothing about
// the company's shape, and the audio there is chosen by whoever holds the
// phone. A company-wide name list in the transcription instruction would put
// that roster one prompt line away from an attacker-chosen payload.
//
// Asserting that `none` RETURNS an empty vocabulary would pass even if the
// fetch still ran. What is asserted instead is that the database is never
// asked, which is the property that actually matters.
{
  eq('the worker path asks for NO vocabulary', WORKER_VOCABULARY_SCOPE, 'none');

  let touched: string[] = [];
  const spyDb = {
    from(table: string) {
      touched.push(table);
      const chain: Record<string, unknown> = {};
      for (const m of ['select', 'eq', 'order', 'limit']) chain[m] = () => chain;
      (chain as { then: unknown }).then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
      return chain;
    },
  } as unknown as Parameters<typeof resolveTranscriptionVocabulary>[0];

  const none = await resolveTranscriptionVocabulary(spyDb, 'company-1', 'none');
  eq('scope "none" reads NOTHING from the database', touched.length, 0);
  check(
    'and yields an empty vocabulary',
    none.workerNames.length === 0 && none.jobNames.length === 0 && none.learnedTerms.length === 0,
  );

  // The positive control. Without it, a `resolveTranscriptionVocabulary` that
  // had been broken into reading nothing at all would pass the check above and
  // silently cost the MANAGER path its accuracy.
  touched = [];
  await resolveTranscriptionVocabulary(spyDb, 'company-1', 'company');
  check(
    'scope "company" still reads the three vocabulary sources',
    touched.includes('workers') && touched.includes('jobs') && touched.includes('transcription_vocab'),
    touched.join(', '),
  );

  // And the instruction built from an empty vocabulary carries no name lines at
  // all - not an empty "Nomes prováveis:" heading with nothing after it.
  for (const locale of LOCALES) {
    const instruction = buildTranscriptionInstruction(locale, none);
    check(
      `${locale}: an empty vocabulary produces no name hints in the instruction`,
      !/prov[áa]ve(is|les)|Likely (worker|job) names|Termos|Términos|Terms and names/u.test(instruction),
    );
    check(`${locale}: while the language and glossary lines survive`, instruction.length > 100);
  }
}

// ── the photo inbox (0047) ──────────────────────────────────────────────────
// The bug: a crew member sent a photo, Capo asked which task it was of, and by
// the time they answered the bytes were gone — they lived for exactly one turn,
// because a task photo's object key contains the task id. On 3 September that
// produced "I tried 3 times now. Is not working" and five days with no
// task_photos row.
//
// Three things here are worth a check rather than a comment: this tappable
// codec (nothing about the handler layout keeps the five payload shapes apart,
// only that their prefixes do not overlap), the two path builders (segment 1 is the
// tenant boundary the storage policies read, and the inbox prefix has to be
// unmistakable), and the expiry (enforced by the reader, because nothing sweeps
// the table).
{
  const more = photoBatchPayload('more');
  const done = photoBatchPayload('done');

  eq('a "more photos" tap round-trips', parsePhotoBatchPayload(more), 'more');
  eq('a "that is everything" tap round-trips', parsePhotoBatchPayload(done), 'done');
  eq('and it is case-insensitive, as Meta echoes what we sent', parsePhotoBatchPayload('CAPO:PHOTOS:DONE'), 'done');
  eq('an unknown answer is rejected', parsePhotoBatchPayload('capo:photos:maybe'), null);
  eq('a foreign prefix is rejected', parsePhotoBatchPayload(`evil:photos:done`), null);
  eq('an empty payload is rejected', parsePhotoBatchPayload(''), null);
  // It carries NO id, the same decision capo:wm:manager makes: which photos it
  // settles comes from the tapper's phone-derived worker id, never the payload.
  check('a photo batch payload contains no uuid', !done.includes(uuid), done);

  // SIX MORE DIRECTIONS. Three of the five shapes arrive under
  // `type: 'interactive'`, and two of those three read the SAME member of the
  // envelope (`button_reply.id`) — the approval card and this one. Nothing but
  // the prefixes keeps a manager's approval from being read as a crew member's
  // photo tap, so every direction is asserted.
  const menuTask4 = workerMenuRowId({ kind: 'task', taskId: uuid });
  const menuManager4 = workerMenuRowId({ kind: 'manager' });
  const checkin4 = checkinPayload('done', uuid);
  const approve4 = proposalButtonId('approve', uuid);

  eq('an approval id is not a photo tap', parsePhotoBatchPayload(approve4), null);
  eq('a check-in payload is not a photo tap', parsePhotoBatchPayload(checkin4), null);
  eq('a menu task row is not a photo tap', parsePhotoBatchPayload(menuTask4), null);
  eq('the manager row is not a photo tap', parsePhotoBatchPayload(menuManager4), null);
  eq('a photo tap is not an approval id', parseProposalButtonId(done), null);
  eq('a photo tap is not a check-in payload', parseCheckinPayload(done), null);
  eq('a photo tap is not a menu row', parseWorkerMenuRowId(done), null);

  // ── AND THE FIFTH SHAPE, which landed in the same integration ────────────
  // The welcome's "Say hi" (capo:hi) is asserted against the three OLDER
  // codecs in its own block above, and this codec against the same three here.
  // These four directions are the pair the two blocks would otherwise leave
  // uncovered, and it is the pair that matters most: capo:hi and capo:photos:
  // share this envelope field EXACTLY — both arrive as
  // `interactive.button_reply.id` — so nothing but the prefixes keeps a hello
  // from being read as "that's everything, attach them".
  const hi5 = hiPayload();
  eq('a hi is not a photo tap', parsePhotoBatchPayload(hi5), null);
  check('a photo tap is not a hi', !isHiPayload(done));
  check('nor is the other photo tap', !isHiPayload(more));
  check(
    'and a photo tap reads as a hi tap in neither envelope',
    !isHiTap({ type: 'interactive', interactive: { button_reply: { id: done } } }) &&
      !isHiTap({ type: 'button', button: { payload: done } }),
  );
}

// ── the two object keys ─────────────────────────────────────────────────────
// Segment 1 is the company on BOTH, which is the whole reason 0047 needed no
// new storage policy: 0023's policies compare (storage.foldername(name))[1]
// against private.current_company_id() and read nothing else. Segment 2 of the
// inbox key is the literal word `inbox`, which is not a uuid, so a staged
// object can never land inside a task's folder.
{
  const company = '11111111-1111-1111-1111-111111111111';
  const worker = '22222222-2222-2222-2222-222222222222';
  const task = '33333333-3333-3333-3333-333333333333';
  const inbox = taskPhotoInboxPath(company, worker, 'abc', 'image/jpeg');
  const attached = taskPhotoPath(company, task, 'abc', 'image/jpeg');

  eq('a staged photo lives under the company then inbox then the worker', inbox, `${company}/inbox/${worker}/abc.jpg`);
  eq('an attached photo lives under the company then the task', attached, `${company}/${task}/abc.jpg`);
  eq('both keys start with the company, which IS the storage boundary', inbox.split('/')[0], attached.split('/')[0]);
  // The CHECK constraints in 0047 re-derive both of these in SQL. A staged key
  // that satisfied task_photos_path_scoped would mean a photo could be written
  // as evidence without ever being attached to anything.
  check('a staged key never satisfies the task_photos path shape', !inbox.startsWith(`${company}/${task}/`), inbox);
  eq('the inbox segment is a literal word, never a uuid', inbox.split('/')[1], 'inbox');
}

// ── the expiry, enforced by the reader ──────────────────────────────────────
// Nothing sweeps worker_photo_inbox, so `expires_at` is only ever true because
// the reader asks. Fail CLOSED on anything unreadable: the cost in this
// direction is that a photo has to be sent again, and in the other it is a
// photo of yesterday's work filed as proof of today's.
{
  const now = Date.parse('2026-09-03T12:00:00Z');
  eq('the window is a full day', PHOTO_INBOX_TTL_MS, 24 * 60 * 60 * 1000);
  // Deliberately LONGER than the check-in request's TTL, and the two are not
  // the same kind of thing: that one bounds what an unlabelled photo may be
  // BELIEVED to be about, this one bounds only how long we keep offering
  // somebody their own photo back.
  check(
    'and it is longer than the check-in request it outlives',
    PHOTO_INBOX_TTL_MS > PHOTO_REQUEST_TTL_MS,
    `${PHOTO_INBOX_TTL_MS} vs ${PHOTO_REQUEST_TTL_MS}`,
  );
  check('a photo staged now is live now', photoInboxLive(photoInboxExpiry(now), now));
  check(
    'a photo staged at 08:00 is still live when they explain it at 17:00',
    photoInboxLive(photoInboxExpiry(Date.parse('2026-09-03T08:00:00Z')), Date.parse('2026-09-03T17:00:00Z')),
  );
  check(
    'and dead by the next working morning',
    !photoInboxLive(photoInboxExpiry(Date.parse('2026-09-03T08:00:00Z')), Date.parse('2026-09-04T09:00:00Z')),
  );
  // The honest edge, pinned rather than glossed: a photo taken at 08:00 IS
  // still waiting at the next day's 07:00 briefing, because 24 hours from 08:00
  // is 08:00. That is safe here in a way it would not be for a check-in photo
  // request: nothing guesses what this photo is of. The crew member names the
  // task themselves, and the model is shown the time each photo arrived.
  check(
    'a photo from yesterday morning survives to this morning, and that is deliberate',
    photoInboxLive(photoInboxExpiry(Date.parse('2026-09-03T08:00:00Z')), Date.parse('2026-09-04T07:00:00Z')),
  );
  check('one minute short of a day is live', photoInboxLive(photoInboxExpiry(now), now + PHOTO_INBOX_TTL_MS - 60_000));
  check('one minute past it is not', !photoInboxLive(photoInboxExpiry(now), now + PHOTO_INBOX_TTL_MS + 60_000));
  check('an expired photo is dead', !photoInboxLive('2026-09-03T11:59:59Z', now));
  check('a missing expiry reads as expired', !photoInboxLive(null, now));
  check('and so does an unparseable one', !photoInboxLive('soon', now));
  check('the prompt block is capped', MAX_INBOX_PHOTOS > 0 && MAX_INBOX_PHOTOS <= 40, String(MAX_INBOX_PHOTOS));
}

// ── only photos that arrived AFTER the request opened (fix round 1) ─────────
// The sequence that makes this necessary is ordinary, not adversarial: a photo
// at 15:00 of some other job (buttons go out, no request open), a 16:00
// check-in tap opening a request for tasks A and B, and the crew member
// scrolling up to tap the 15:00 message's "É tudo". Without the filter that
// 15:00 photo becomes proof of task A: evidence, wrong, and undeletable.
{
  const opened = '2026-09-03T16:00:00Z';
  const older = { id: 'a', receivedAt: '2026-09-03T15:00:00Z' };
  const newer = { id: 'b', receivedAt: '2026-09-03T16:30:00Z' };
  const exact = { id: 'c', receivedAt: opened };

  eq('a photo from before the request is refused', photosSinceRequest([older], opened).length, 0);
  eq('a photo from after it is taken', photosSinceRequest([newer], opened).map(p => p.id).join(), 'b');
  // The bare-photo path stages and attaches in one request, so its photo's
  // timestamp can equal the request's to the millisecond. Exclusive would drop
  // the one photo this whole path exists to file.
  eq('a photo from the same instant is taken', photosSinceRequest([exact], opened).map(p => p.id).join(), 'c');
  eq('a mixed batch keeps only the newer half', photosSinceRequest([older, newer], opened).map(p => p.id).join(), 'b');
  // Empty means the caller falls through, so the older photos stay in the inbox
  // for the agent path rather than being attached to the wrong job OR lost.
  eq('an entirely older batch yields nothing to attach', photosSinceRequest([older], opened).length, 0);
  eq('an unparseable request timestamp excludes everything', photosSinceRequest([newer], 'soon').length, 0);
  eq('a missing one does too', photosSinceRequest([newer], null).length, 0);
  eq('and so does an unparseable photo timestamp', photosSinceRequest([{ id: 'd', receivedAt: 'x' }], opened).length, 0);
}

// ── the copy that answers a bare photo ──────────────────────────────────────
// Meta clamps nothing: a button title over 20 characters is a 400, and the
// sender clamps rather than throws precisely because a translator lengthening a
// label must degrade to a truncated word. Asserting the untruncated length here
// is what keeps the clamp from ever being reached.
for (const locale of LOCALES) {
  const t = getCatalog(locale).whatsapp;
  check(`${locale}: the "more photos" button fits`, t.photoBatchMoreButton.length <= 20, t.photoBatchMoreButton);
  check(`${locale}: the "that is everything" button fits`, t.photoBatchDoneButton.length <= 20, t.photoBatchDoneButton);
  // The count is the running total of what is WAITING, not what arrived in this
  // message, so somebody sending four in a row watches it climb. A receipt that
  // said "1" four times is the message that produced "I tried 3 times now".
  check(`${locale}: the receipt names the count when there is more than one`, t.photoBatchAsk(3).includes('3'), t.photoBatchAsk(3));
  check(`${locale}: and reads naturally for the first one`, t.photoBatchAsk(1).length > 0, t.photoBatchAsk(1));
  // It must NOT claim anything was recorded: nothing has been filed at this
  // point, and a photo waiting is a photo waiting.
  for (const key of ['photoBatchAsk', 'photoBatchMoreAck', 'photoBatchNone'] as const) {
    const body = key === 'photoBatchAsk' ? t.photoBatchAsk(2) : t[key];
    check(`${locale}: ${key} is one short line`, body.length > 0 && body.length <= 160, body);
  }
}
// ── the immediate assignment note (issue W7) ────────────────────────────────
//
// "When we assign a new task to a worker we need to send it immediately, only
// in working hours." Before this, a task given to somebody at nine in the
// morning reached them at 07:00 the NEXT day, and nothing told the manager the
// person had not been told.
//
// Four things are pinned here, and each of them is a defect with no build-time
// signal:
//   * The message must say WHY it arrived. Reusing the 07:00 greeting would
//     open an afternoon message with "Bom dia".
//   * The new task must be MARKED. The whole day is sent, so an unmarked one
//     makes the reader hunt for the change.
//   * The marker must be a PREFIX. `taskHeadline` renders "Pintar tecto (Casa
//     de Paco)", so a suffix produces two unrelated parentheses in a row.
//   * The paid template must not go out to a locale Meta has not approved:
//     that is a 132001 per recipient, which reads as a broken send rather than
//     as a missing approval.
{
  const NEW_TASK = '11111111-1111-4111-8111-111111111111';
  const OLD_TASK = '22222222-2222-4222-8222-222222222222';

  function assignmentTask(id: string, title: string): BriefingTask {
    return {
      id,
      title,
      job_name: 'Casa de Paco',
      overdue: false,
      days_overdue: 0,
      description: null,
      materials: [],
      job_address: null,
      waiting_on: [],
      awaiting_review: false,
      due_date: null,
      role: 'lead',
    };
  }

  function assignmentBriefing(locale: Locale): WorkerBriefing {
    return {
      workerId: uuid,
      name: 'Miguel',
      recipient: { kind: 'phone', waId },
      locale,
      hasChosenLanguage: false,
      tasks: [assignmentTask(NEW_TASK, 'Pintar tecto'), assignmentTask(OLD_TASK, 'Canalização')],
      lastInboundAt: new Date().toISOString(),
    };
  }

  for (const locale of LOCALES) {
    const t = getCatalog(locale).reminders;
    const body = renderAssignmentMessage(assignmentBriefing(locale), new Set([NEW_TASK]));

    check(
      `${locale}: the note opens by saying a task was just assigned`,
      body.startsWith(t.assignmentGreeting({ name: 'Miguel', count: 1 })),
      body.slice(0, 80),
    );
    // NOT the morning greeting. This message goes out at any hour of the
    // working day, and "Bom dia" at 15:00 is the tell that a renderer was
    // reused without being read.
    check(
      `${locale}: and NOT with the 07:00 greeting`,
      !body.includes(t.freeFormGreeting('Miguel')),
      body.slice(0, 80),
    );
    // The rest of the day is still there, unmarked, from the SAME renderer the
    // 07:00 briefing uses.
    check(`${locale}: the whole day is carried, not just the new task`, body.includes('Canalização'), body);
    check(`${locale}: the new task is marked`, body.includes(t.taskNewlyAssigned('Pintar tecto')), body);
    check(
      `${locale}: and the task they already knew about is NOT`,
      !body.includes(t.taskNewlyAssigned('Canalização')),
      body,
    );
    // A PREFIX. "Pintar tecto (nova) (Casa de Paco)" is what a suffix produces.
    check(
      `${locale}: the marker sits in front of the title, not between it and the obra`,
      body.includes(`${t.taskNewlyAssigned('Pintar tecto')} `) || body.includes(t.taskWithJob(t.taskNewlyAssigned('Pintar tecto'), 'Casa de Paco')),
      body,
    );
    check(`${locale}: the obra survives the marking`, body.includes('Casa de Paco'), body);

    // The paid template's {{2}}: only what is new, and one flat line — Meta
    // rejects a newline in a body parameter with 132000.
    const param = renderAssignmentTemplateParam([assignmentTask(NEW_TASK, 'Pintar tecto')], locale);
    check(`${locale}: the template parameter names the new task`, param.includes('Pintar tecto'), param);
    check(`${locale}: and carries no newline`, !param.includes('\n'), JSON.stringify(param));
    check(
      `${locale}: and does NOT carry the rest of the day`,
      !param.includes('Canalização'),
      param,
    );
  }

  // The day link rides this message exactly as it rides the 07:00 one.
  const LINK = 'https://www.construcapo.com/dia?t=abc123';
  const linked = renderAssignmentMessage(assignmentBriefing('pt-PT'), new Set([NEW_TASK]), {
    dayLinkUrl: LINK,
  });
  check('the crew day link rides the assignment note', linked.includes(LINK), linked.slice(-160));

  // ── the two gates ─────────────────────────────────────────────────────────
  // Quiet hours. The full window is asserted in scripts/scheduler-check.mts,
  // beside the other Lisbon-hour gates; what is pinned HERE is that the SEND
  // path consults one at all — a manager doing admin at midnight must not wake
  // their crew.
  check('nothing is announced at 03:00', !withinAssignmentHours(3));
  check('nothing is announced at 23:00', !withinAssignmentHours(23));
  check('an assignment at midday is announced', withinAssignmentHours(12));

  // ── the approval switch ───────────────────────────────────────────────────
  // What stands between an unapproved template and a 132001 for every
  // out-of-window crew member. Asserted as a MEMBERSHIP RULE rather than
  // against the set it wraps — comparing the function to its own source cannot
  // fail, which is the trap BRIEFING_V2_APPROVED_LANGUAGES' own block avoids.
  //
  // Every entry must be a REAL Meta locale code we ship, or a typo would read
  // as "approved for nobody" and be invisible.
  for (const language of TASK_ASSIGNED_APPROVED_LANGUAGES) {
    check(
      `${language} is a locale this product actually has`,
      TEMPLATE_LANGUAGES.includes(language),
      language,
    );
    check(`and ${language} is therefore sendable`, taskAssignedTemplateApproved(language));
  }
  // Anything NOT in the set falls to "do not send", including the three shipped
  // locales while they are still awaiting review, and any code this file has
  // never heard of.
  for (const language of TEMPLATE_LANGUAGES) {
    if (TASK_ASSIGNED_APPROVED_LANGUAGES.has(language)) continue;
    check(
      `capo_task_assigned in ${language} is NOT sent while unapproved`,
      !taskAssignedTemplateApproved(language),
    );
  }
  check(
    'an unknown locale code is never treated as approved',
    !taskAssignedTemplateApproved('fr_FR'),
  );
  // The hyphenated app locale is NOT the Meta code. Putting 'pt-PT' in the set
  // would silently approve nobody — the switch is keyed on templateLanguage.
  check(
    'the app locale form is never mistaken for the Meta code',
    !taskAssignedTemplateApproved('pt-PT'),
  );

  // ── the plural opener (the coalescing window's own copy defect) ───────────
  // The deferral folds several assignments into ONE message, so "uma tarefa
  // nova" is wrong in exactly the case that mechanism creates. The count comes
  // from what was MARKED, never from the size of the queued id set.
  {
    const both = renderAssignmentMessage(
      assignmentBriefing('pt-PT'),
      new Set([NEW_TASK, OLD_TASK]),
    );
    const t = getCatalog('pt-PT').reminders;
    check(
      'two tasks in one message open in the plural',
      both.startsWith(t.assignmentGreeting({ name: 'Miguel', count: 2 })),
      both.slice(0, 80),
    );
    // A queued task that has left this person's board is not marked, so it must
    // not be counted either — otherwise the opener says "2 tarefas novas" above
    // a day that shows one.
    const ghost = renderAssignmentMessage(
      assignmentBriefing('pt-PT'),
      new Set([NEW_TASK, 'ffffffff-ffff-4fff-8fff-ffffffffffff']),
    );
    check(
      'a task no longer on the board is not counted in the opener',
      ghost.startsWith(t.assignmentGreeting({ name: 'Miguel', count: 1 })),
      ghost.slice(0, 80),
    );
  }
}

// ── the assignment drain's decisions, and its send ORDER (issue W7) ─────────
//
// The defects these pin all send a real crew member something untrue or
// duplicated, and none of them is visible to a type checker:
//   * Two drains overlapping by seconds both sending a whole-day message. The
//     free-form path writes nothing to notification_log — that is the PAID
//     ledger — so the queue row itself is the only lock there is.
//   * A crew member reassigned away between the queue and the drain reading
//     "your boss just gave you a new task", followed by the empty-day line.
//   * An evening assignment of tomorrow's work going out the next morning, an
//     hour after the 07:00 briefing already said it.
{
  // ── the per-person decision, and the ORDER of its reasons ─────────────────
  eq(
    'a crew member who may not be messaged is a final answer',
    decideDelivery({ messageable: false, newTaskCount: 1, recentlyEngaged: false }).kind,
    'skip',
  );
  // ⚠ ORDER. A permanent skip must outrank a deferral, or somebody who can
  // never be messaged sits in the queue being reconsidered every fifteen
  // minutes for ever.
  eq(
    'and it outranks the coalescing deferral',
    decideDelivery({ messageable: false, newTaskCount: 1, recentlyEngaged: true }).kind,
    'skip',
  );
  {
    const d = decideDelivery({ messageable: true, newTaskCount: 0, recentlyEngaged: false });
    eq('a task no longer theirs sends nothing', d.kind, 'skip');
    eq(
      '…and says so on the row',
      d.kind === 'skip' ? d.outcome : null,
      'reassigned',
    );
  }
  eq(
    'a reassignment also outranks the deferral',
    decideDelivery({ messageable: true, newTaskCount: 0, recentlyEngaged: true }).kind,
    'skip',
  );
  eq(
    'somebody messaged moments ago is deferred, not skipped',
    decideDelivery({ messageable: true, newTaskCount: 1, recentlyEngaged: true }).kind,
    'defer',
  );
  eq(
    'and the ordinary case sends',
    decideDelivery({ messageable: true, newTaskCount: 2, recentlyEngaged: false }).kind,
    'send',
  );

  // ── what counts as "already messaged" ─────────────────────────────────────
  // `sending` is the whole point: a drain that has CLAIMED but not yet heard
  // back from Meta has already committed. Reading only the finished outcomes
  // left the guard blind in exactly the two-seconds-apart case it exists for.
  check('a claim in flight counts as already messaged', ENGAGED_OUTCOMES.has('sending'));
  check('so does a finished free-form send', ENGAGED_OUTCOMES.has('sent_free_form'));
  check('and a paid template', ENGAGED_OUTCOMES.has('sent_template'));
  // Everything that reached nobody must NOT suppress the next attempt.
  for (const quiet of ['not_today', 'stale', 'not_messageable', 'reassigned', 'template_unapproved', 'send_failed', 'not_billable', 'outside_hours'] as const) {
    check(`"${quiet}" does not suppress a later message`, !ENGAGED_OUTCOMES.has(quiet));
  }

  // ── yesterday's leftovers ─────────────────────────────────────────────────
  // An out-of-hours notice is deliberately left queued. Without this test the
  // commonest manager habit there is — planning tomorrow at nine in the evening
  // — produces a "new task" message the next morning, an hour after the 07:00
  // briefing already carried it.
  check('a notice queued today is live', !noticeIsStale('2026-09-03', '2026-09-03'));
  check('one queued last night is stale', noticeIsStale('2026-09-02', '2026-09-03'));
  check('one queued for tomorrow is stale too', noticeIsStale('2026-09-04', '2026-09-03'));
  // Fails toward silence: an absent or unreadable column sends nothing, and the
  // task is still on the board for the morning.
  check('a missing queued_date reads as stale', noticeIsStale(null, '2026-09-03'));
  check('an unreadable one reads as stale', noticeIsStale(undefined, '2026-09-03'));

  // ── CLAIM, THEN SEND ──────────────────────────────────────────────────────
  {
    const order: string[] = [];
    const result = await claimThenSend({
      ids: ['a', 'b'],
      claim: async ids => {
        order.push(`claim:${ids.join(',')}`);
        return ['a', 'b'];
      },
      send: async won => {
        order.push(`send:${won.join(',')}`);
        return 'ok';
      },
    });
    eq('the claim happens FIRST', order[0], 'claim:a,b');
    eq('and the send SECOND', order[1], 'send:a,b');
    eq('nothing else happens', order.length, 2);
    check('and the send is reported', result.sent);
    eq('with the won ids', result.won.join(','), 'a,b');
  }
  {
    // The losing drain. Another drain claimed the rows two seconds ago; this
    // one must not message anybody, and must not stamp rows it does not own.
    const order: string[] = [];
    const result = await claimThenSend({
      ids: ['a'],
      claim: async () => {
        order.push('claim');
        return [];
      },
      send: async () => {
        order.push('send');
        return 'ok';
      },
    });
    check('a drain that wins nothing does not send', !order.includes('send'), order.join('|'));
    check('and reports that it sent nothing', !result.sent);
    eq('and claims nothing', result.won.length, 0);
  }
  {
    // A PARTIAL win: the other drain took one row. Only what was won may be
    // sent about, or two drains both announce the same task as new.
    const seen: string[][] = [];
    await claimThenSend({
      ids: ['a', 'b'],
      claim: async () => ['b'],
      send: async won => {
        seen.push([...won]);
        return 'ok';
      },
    });
    eq('a partial win sends only what it won', JSON.stringify(seen), '[["b"]]');
  }
  {
    const order: string[] = [];
    const result = await claimThenSend({
      ids: [],
      claim: async () => {
        order.push('claim');
        return [];
      },
      send: async () => {
        order.push('send');
        return 'ok';
      },
    });
    check('an empty batch touches nothing at all', order.length === 0, order.join('|'));
    check('and sends nothing', !result.sent);
  }
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(lines.join('\n'));
console.log(`\nWhatsApp check: ${lines.length - failures}/${lines.length} passed; failures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
