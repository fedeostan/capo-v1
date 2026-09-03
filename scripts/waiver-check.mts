// Waiver check — the rule that decides when a crew member may finish a task
// without a photo.
//
// `declare_task_done` has required proof at the schema level since #22, and the
// requirement is the reason a completion claim means anything. 0049 gives it
// the exit it never had: Capo asks for a photo on the first and second inbound
// message that declares a task finished without one, and only the THIRD may
// record it, with the crew member's own reason attached and the claim flagged
// to the manager. "There is no light" is a real answer on a building site at
// seven in the evening; "that is the rule no matter what" is how somebody stops
// telling anybody anything.
//
// The decision is `decidePhotoWaiver`
// (packages/core/src/capabilities/worker/photo-waiver.ts): pure, no Db, no
// clock, no locale. It needs assertions more than almost anything else on the
// worker path, because every way it can be wrong is SILENT:
//
//   1. Too loose and the requirement is gone. If the count ever advanced on
//      something the model controls — a tool call rather than a message — then
//      a model that calls the tool three times in one turn waives on the first
//      message, and nothing anywhere errors. That is the whole reason the unit
//      of counting is Meta's inbound message id, and it is the first thing
//      pinned below.
//   2. Too strict and the feature does not exist. A crew member who genuinely
//      cannot photograph anything is refused for ever, which is precisely the
//      state 0049 was written to end, and it also produces no error.
//   3. A waiver with no reason. The manager's whole surface for this is the
//      quote — "diz que não há luz" — and a waived claim with an empty note
//      tells them nothing they could act on.
//   4. A double count. Recording attempt 1 twice for one message would let two
//      messages reach the third attempt. The two unique indexes in 0049 are the
//      backstop; the `attemptNo === null` on a repeat is what stops us asking
//      for that refusal in the first place.
//   5. Asks that outlive the claim they belong to (fix round 1, I2). Two asks
//      are a fact about ONE attempt to report ONE piece of work. If they
//      survived the claim, then after a manager REJECTED a claim and the work
//      was redone, the very next message about that task could be waived on its
//      first try — a second "sem foto" claim about different work, with no
//      evidence Capo ever asked. `cycleStartedAt` is the boundary, and the
//      numbering has to survive it: `attempt_no` is unique across the whole
//      (conversation, task) pair, so restarting at 1 would be refused by the
//      database, the count would never advance, and the crew member could never
//      report that job again.
//
// Credential-free, no network and no model, like `pnpm guard-check` and
// `pnpm scheduler-check`. Run with `pnpm waiver-check`. Exit 0 = green.

import {
  WAIVER_ASKS_REQUIRED,
  decidePhotoWaiver,
  type PhotoWaiverAttempt,
} from '@capo/core/capabilities/worker/photo-waiver';

let failures = 0;
const lines: string[] = [];

function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures += 1;
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function eq(name: string, actual: unknown, expected: unknown) {
  check(name, actual === expected, `got ${String(actual)}, want ${String(expected)}`);
}

// Attempts, oldest first, one per hour from 10:00 on 5 January. `createdAt`
// matters now: attempts recorded before the task's most recent review belong to
// a claim that has already been made and do not count.
const T = (h: number) => `2026-01-05T${String(h).padStart(2, '0')}:00:00.000Z`;
const at = (...ids: string[]): PhotoWaiverAttempt[] =>
  ids.map((inboundMessageId, i) => ({ inboundMessageId, attemptNo: i + 1, createdAt: T(10 + i) }));

const M1 = 'wamid.HBgLMzUx.AAAA';
const M2 = 'wamid.HBgLMzUx.BBBB';
const M3 = 'wamid.HBgLMzUx.CCCC';

// ── the constant ────────────────────────────────────────────────────────────
// Two asks, so the waiving message is the third. Pinned on its own because
// every count below is derived from it: if somebody makes it 1, the checks
// further down would drift with it and quietly keep passing.
eq('two asks are required before a waiver', WAIVER_ASKS_REQUIRED, 2);

// ── photos present: the waiver is not on the table at all ───────────────────
{
  const d = decidePhotoWaiver({ attempts: [], currentInboundId: M1, hasPhotos: true });
  eq('the call named a photo, so the outcome is photos', d.outcome, 'photos');
  eq('and nothing is recorded', d.attemptNo, null);
  eq('and no reason is carried', d.reason, null);
}
{
  // The dangerous version of the same case: two asks already on file AND a
  // photo now waiting. The photo must win — waiving here would file a claim
  // with no proof while proof was sitting in the inbox.
  const d = decidePhotoWaiver({
    attempts: at(M1, M2),
    currentInboundId: M3,
    hasPhotos: true,
    reason: 'não há luz',
  });
  eq('a named photo beats two prior asks and a reason', d.outcome, 'photos');
  eq('and still records nothing', d.attemptNo, null);
}

// ── the three asks, across three distinct messages ──────────────────────────
{
  const first = decidePhotoWaiver({ attempts: [], currentInboundId: M1, hasPhotos: false });
  eq('no photo and nothing on file asks plainly', first.outcome, 'ask_first');
  eq('and records attempt 1', first.attemptNo, 1);
  eq('with no prior asks counted', first.priorAsks, 0);

  const second = decidePhotoWaiver({ attempts: at(M1), currentInboundId: M2, hasPhotos: false });
  eq('a second message asks again', second.outcome, 'ask_again');
  eq('and records attempt 2', second.attemptNo, 2);
  eq('with one prior ask counted', second.priorAsks, 1);

  const third = decidePhotoWaiver({
    attempts: at(M1, M2),
    currentInboundId: M3,
    hasPhotos: false,
    reason: 'não há luz',
  });
  eq('the third message with a reason waives', third.outcome, 'waive');
  eq('and records attempt 3', third.attemptNo, 3);
  eq('and carries their own words', third.reason, 'não há luz');
}

// ── THE SHORTCUT THE MODEL WOULD OTHERWISE HAVE ─────────────────────────────
// Three tool calls inside ONE turn share one inbound message id. If any of them
// waived, the requirement would be decorative: the model alone could reach the
// third attempt with the crew member having said "acabei" exactly once.
{
  const call1 = decidePhotoWaiver({ attempts: [], currentInboundId: M1, hasPhotos: false });
  eq('call 1 of one turn asks', call1.outcome, 'ask_first');
  eq('and records attempt 1', call1.attemptNo, 1);

  // The row call 1 wrote is now on file, and the id is the SAME.
  const call2 = decidePhotoWaiver({ attempts: at(M1), currentInboundId: M1, hasPhotos: false });
  eq('call 2 of the SAME turn still asks first', call2.outcome, 'ask_first');
  eq('and counts no prior ask', call2.priorAsks, 0);
  eq('and records NOTHING, so the count cannot advance', call2.attemptNo, null);

  const call3 = decidePhotoWaiver({
    attempts: at(M1),
    currentInboundId: M1,
    hasPhotos: false,
    reason: 'não há luz',
  });
  eq('call 3 of the same turn does not waive even with a reason', call3.outcome, 'ask_first');
  eq('and records nothing either', call3.attemptNo, null);
}
{
  // The same shortcut attempted from the second turn: two rows on file, but one
  // of them is THIS message. Only one distinct earlier message exists, so this
  // is the second ask and not the third.
  const d = decidePhotoWaiver({
    attempts: at(M1, M2),
    currentInboundId: M2,
    hasPhotos: false,
    reason: 'não há luz',
  });
  eq('a repeat inside the second turn is still the second ask', d.outcome, 'ask_again');
  eq('with exactly one distinct earlier message', d.priorAsks, 1);
  eq('and nothing new recorded', d.attemptNo, null);
}
{
  // Duplicate rows for one message must not count twice. A retry, a redelivered
  // webhook or a backfill could produce them.
  const d = decidePhotoWaiver({ attempts: at(M1, M1, M1), currentInboundId: M2, hasPhotos: false });
  eq('three rows for ONE message are one ask', d.priorAsks, 1);
  eq('so the second message asks again rather than waiving', d.outcome, 'ask_again');
  // The NUMBER is one past the highest on file, not one past the ask count:
  // 0049's unique index is on (conversation, task, attempt_no) and reusing a
  // number is a refused insert, which is a count that never advances.
  eq('and it is numbered past every row on file', d.attemptNo, 4);
}

// ── THE CLAIM CYCLE (fix round 1, I2) ───────────────────────────────────────
// Two asks belong to ONE attempt to report ONE piece of work. Once a claim has
// been filed on the task — waived, photographed, later rejected, whatever
// happened to it — the next report starts from nothing. Without this, the
// second claim on a task could be waived on its very first message.
{
  // Two asks on file at 10:00 and 11:00; a review was filed at 12:00. The crew
  // member comes back afterwards (the manager rejected it, the work was redone)
  // and says it is finished with no photo.
  const d = decidePhotoWaiver({
    attempts: at(M1, M2),
    currentInboundId: M3,
    hasPhotos: false,
    reason: 'não há luz',
    cycleStartedAt: T(12),
  });
  eq('asks from before the last claim do not count', d.priorAsks, 0);
  eq('so the next report is asked from the start', d.outcome, 'ask_first');
  eq('and the attempt number continues past the old rows', d.attemptNo, 3);
}
{
  // The same rows with NO review on the task: nothing has been claimed, so
  // every ask still counts. This is the ordinary first-report case and it must
  // be unchanged by the cycle filter.
  const d = decidePhotoWaiver({
    attempts: at(M1, M2),
    currentInboundId: M3,
    hasPhotos: false,
    reason: 'não há luz',
    cycleStartedAt: null,
  });
  eq('with no claim ever filed, every ask counts', d.priorAsks, 2);
  eq('and the third message waives', d.outcome, 'waive');
}
{
  // Asks recorded AFTER the boundary count normally: the second cycle reaches
  // its own third message and waives there, exactly as the first did.
  const attempts: PhotoWaiverAttempt[] = [
    { inboundMessageId: M1, attemptNo: 1, createdAt: T(10) },
    { inboundMessageId: M2, attemptNo: 2, createdAt: T(11) },
    { inboundMessageId: 'wamid.NEW.1', attemptNo: 3, createdAt: T(13) },
    { inboundMessageId: 'wamid.NEW.2', attemptNo: 4, createdAt: T(14) },
  ];
  const d = decidePhotoWaiver({
    attempts,
    currentInboundId: 'wamid.NEW.3',
    hasPhotos: false,
    reason: 'continua sem luz',
    cycleStartedAt: T(12),
  });
  eq('the new cycle counts only its own asks', d.priorAsks, 2);
  eq('and waives on its own third message', d.outcome, 'waive');
  eq('numbered past every row, old cycle included', d.attemptNo, 5);
}
{
  // A row written at the very moment of the claim does not count: the boundary
  // is exclusive, so an attempt and the claim it produced never both count.
  const attempts: PhotoWaiverAttempt[] = [
    { inboundMessageId: M1, attemptNo: 1, createdAt: T(10) },
    { inboundMessageId: M2, attemptNo: 2, createdAt: T(12) },
  ];
  const d = decidePhotoWaiver({ attempts, currentInboundId: M3, hasPhotos: false, cycleStartedAt: T(12) });
  eq('an attempt stamped at the claim itself does not count', d.priorAsks, 0);
}
{
  // An UNPARSEABLE boundary excludes everything. loadClaimCycleStart never
  // throws and answers "now" on a failed read, so the same thing happens there:
  // Capo asks again rather than inheriting asks it cannot place.
  const d = decidePhotoWaiver({
    attempts: at(M1, M2),
    currentInboundId: M3,
    hasPhotos: false,
    reason: 'não há luz',
    cycleStartedAt: 'not a date',
  });
  eq('an unreadable cycle boundary counts nothing', d.priorAsks, 0);
  eq('and asks from the start', d.outcome, 'ask_first');
}
{
  // An unparseable ROW timestamp drops that row, same direction.
  const attempts: PhotoWaiverAttempt[] = [
    { inboundMessageId: M1, attemptNo: 1, createdAt: 'nonsense' },
    { inboundMessageId: M2, attemptNo: 2, createdAt: T(13) },
  ];
  const d = decidePhotoWaiver({ attempts, currentInboundId: M3, hasPhotos: false, cycleStartedAt: T(12) });
  eq('an unreadable attempt timestamp does not count', d.priorAsks, 1);
  eq('so this is the second ask', d.outcome, 'ask_again');
}
{
  // The same-turn repeat is refused across cycles too. `attempt_no` and
  // `inbound_message_id` are BOTH unique for the whole (conversation, task)
  // pair, so a message already on file from an earlier cycle can never be
  // recorded again — asking for it would be a refused insert.
  const attempts: PhotoWaiverAttempt[] = [{ inboundMessageId: M1, attemptNo: 1, createdAt: T(10) }];
  const d = decidePhotoWaiver({ attempts, currentInboundId: M1, hasPhotos: false, cycleStartedAt: T(12) });
  eq('a message already on file records nothing, cycle or no cycle', d.attemptNo, null);
}

// ── the reason is required, and it is theirs ────────────────────────────────
{
  const none = decidePhotoWaiver({ attempts: at(M1, M2), currentInboundId: M3, hasPhotos: false });
  eq('the third ask with no reason asks for one', none.outcome, 'need_reason');
  eq('and still records the attempt', none.attemptNo, 3);
  eq('and carries no reason', none.reason, null);

  const blank = decidePhotoWaiver({
    attempts: at(M1, M2),
    currentInboundId: M3,
    hasPhotos: false,
    reason: '   \n  ',
  });
  eq('whitespace is not a reason', blank.outcome, 'need_reason');

  const nulled = decidePhotoWaiver({
    attempts: at(M1, M2),
    currentInboundId: M3,
    hasPhotos: false,
    reason: null,
  });
  eq('an explicit null is not a reason', nulled.outcome, 'need_reason');

  const padded = decidePhotoWaiver({
    attempts: at(M1, M2),
    currentInboundId: M3,
    hasPhotos: false,
    reason: '  o telemóvel morreu  ',
  });
  eq('a padded reason is trimmed, never rewritten', padded.reason, 'o telemóvel morreu');
  eq('and it waives', padded.outcome, 'waive');
}
{
  // Once they have given a reason, a FOURTH message still waives. The rule is
  // "at least two asks", not "exactly three messages": a crew member who was
  // asked why and answered on the next message must not be sent round again.
  const d = decidePhotoWaiver({
    attempts: at(M1, M2, M3),
    currentInboundId: 'wamid.HBgLMzUx.DDDD',
    hasPhotos: false,
    reason: 'não há luz',
  });
  eq('a fourth message with a reason still waives', d.outcome, 'waive');
  eq('and is recorded as attempt 4', d.attemptNo, 4);
}

// ── fail closed, in every direction ─────────────────────────────────────────
// A blank inbound id should be impossible: it comes from Meta and the route
// passes `message.id`. If it ever were blank, the failure has to be STRICTER
// rather than looser, because we can no longer tell one turn from the next.
{
  const fresh = decidePhotoWaiver({ attempts: [], currentInboundId: '', hasPhotos: false });
  eq('a blank id still asks', fresh.outcome, 'ask_first');
  eq('and records nothing, so it cannot advance the count', fresh.attemptNo, null);

  const ready = decidePhotoWaiver({
    attempts: at(M1, M2),
    currentInboundId: '',
    hasPhotos: false,
    reason: 'não há luz',
  });
  eq('a blank id NEVER waives, even with two asks on file', ready.outcome, 'ask_again');
  eq('and records nothing', ready.attemptNo, null);
}
{
  // The unapplied-migration case. `loadWaiverAttempts` answers [] on 42P01, so
  // this is what every turn looks like until 0049 is applied: Capo asks, for
  // ever, which is exactly the product as it stands today.
  const d = decidePhotoWaiver({
    attempts: [],
    currentInboundId: M3,
    hasPhotos: false,
    reason: 'não há luz',
  });
  eq('an unreadable attempts table reads as never asked', d.outcome, 'ask_first');
  check('so no claim can be waived before 0049 is applied', d.outcome !== 'waive');
}
{
  // Rows whose id is empty or whitespace contribute nothing. They cannot be
  // written (the column is NOT NULL and the route always has an id), but a
  // counter that could be inflated by junk is a counter worth pinning.
  const d = decidePhotoWaiver({ attempts: at('', '   ', M1), currentInboundId: M2, hasPhotos: false });
  eq('empty rows do not count as asks', d.priorAsks, 1);
  eq('so this is the second ask', d.outcome, 'ask_again');
}

// ── the shape of the answer ─────────────────────────────────────────────────
// Only 'waive' carries a reason. Anything else carrying one would mean a
// refusal path could file a note, and the note is what the manager reads.
{
  const outcomes = [
    decidePhotoWaiver({ attempts: [], currentInboundId: M1, hasPhotos: true, reason: 'x' }),
    decidePhotoWaiver({ attempts: [], currentInboundId: M1, hasPhotos: false, reason: 'x' }),
    decidePhotoWaiver({ attempts: at(M1), currentInboundId: M2, hasPhotos: false, reason: 'x' }),
    decidePhotoWaiver({ attempts: at(M1, M2), currentInboundId: M3, hasPhotos: false }),
  ];
  check(
    'no refusal ever carries a reason',
    outcomes.every(d => d.outcome === 'waive' || d.reason === null),
  );
  check(
    'and no refusal is ever a waiver',
    outcomes.every(d => d.outcome !== 'waive'),
  );
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(lines.join('\n'));
console.log(`\nWaiver check: ${lines.length - failures}/${lines.length} passed; failures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
