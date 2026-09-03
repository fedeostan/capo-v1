import { z } from 'zod';
import {
  attachInboxPhotos,
  markTaskProofPhotos,
  markTaskProofUnknown,
  storeWorkerTaskPhoto,
} from '../../media/task-photo-store';
import { decidePhotoWaiver } from './photo-waiver';
import { loadClaimCycleStart, loadWaiverAttempts, recordWaiverAttempt } from './photo-waiver-store';
import type { WorkerTool } from './types';
import { workerToolError } from './types';

// "Acabei" — a worker declaring a task finished, with proof.
//
// Everything about this tool used to be arranged around one sentence from the
// PRD: PHOTOS ARE MANDATORY AT THE SCHEMA LEVEL, NEVER BY PROMPT INSTRUCTION.
// A prompt rule is negotiable by anyone who can write text, and the person on
// the other end of this conversation can write any text they like.
//
// ── WHAT CHANGED, AND WHAT DID NOT (0049) ──────────────────────────────────
// The requirement had no way out at all, and that was its own bug. "But what if
// there is no light?" — a basement at seven in the evening, a dead phone, a
// lens covered in plaster. Capo's answer was "that is the rule no matter what",
// twice in the same words, and the crew member stopped telling anybody
// anything.
//
// So the requirement is still enforced in CODE and still not by a prompt line;
// what moved is where. `photo_ids` is `.min(0)` and the refusal now happens
// inside `execute`, over rows the model cannot write: Capo asks for a photo on
// the first and second inbound message that declares this task finished without
// one, and only the THIRD may waive, with the crew member's own reason attached
// and the claim flagged to the manager as having no photo. The unit of counting
// is the inbound message id, which Meta mints and every tool call inside one
// turn shares — so the model cannot argue its way to the third attempt, it can
// only wait for the worker to send a third message. See ./photo-waiver.ts.
//
// A waived claim is not a quieter claim. It reaches the manager through its own
// notification kind, its own inbox and push sentence, and a "Sem foto" badge on
// the board, with the reason quoted underneath. And the crew member is told
// that, out loud, in the same breath.
//
// What a successful call produces is a CLAIM, not a completion. The task moves
// to `pending_review` and stays visible on the manager's board, still counted
// overdue if its dates say so (task_board.is_open is a denylist — 0013:71). A
// worker who lies is loud, never silent. The manager approves, rejects or
// dismisses it from the board; 0024's trigger has already put it in their inbox
// and 0026 has already pushed it to their phone, with no edit needed here.

const uuid = z.string().uuid();

export const declareTaskDoneInput = z.object({
  task_id: uuid.describe('From my_tasks. Must be one of THIS crew member\'s own open tasks.'),
  photo_ids: z
    .array(z.string().min(1))
    // `.min(0)` since 0049, and the requirement did NOT move into this
    // sentence. It moved into `execute`, over `task_photo_waiver_attempts`
    // rows the model cannot write: an empty array is refused on the first and
    // second inbound message that uses it, and only the third may waive. If you
    // ever find yourself enforcing the rule here or in a prompt instead, read
    // ./photo-waiver.ts first.
    .min(0)
    .describe(
      'Ids from the "# Photos received" block. Pass ALL of them unless the crew member said some belong to a different job; they may have arrived in earlier messages, not just this one. Pass an empty array ONLY when there are no photos at all and the crew member has said they cannot send one.',
    ),
  note: z
    .string()
    .max(500)
    .optional()
    .describe(
      "The worker's own words about the job, copied as they wrote them — never your summary of them. The manager reads this as a quote attributed to them. Leave it out if they said nothing beyond \"done\".",
    ),
  no_photo_reason: z
    .string()
    .max(200)
    .optional()
    .describe(
      'ONLY when there is no photo: the crew member\'s own words for why, copied as they wrote them (for example "não há luz", "o telemóvel morreu"). Never your summary and never a reason you supplied for them. The manager reads it as a quote with their name on it.',
    ),
});

type DeclareTaskDoneInput = z.infer<typeof declareTaskDoneInput>;

// The `task_photos` row is written by attachInboxPhotos
// (../../media/task-photo-store), which lives beside storeWorkerTaskPhoto in
// the ONE file that writes a crew-sourced row.
// The check-in photo follow-up writes exactly the same shape from the WhatsApp
// route, and what that row carries is an ATTRIBUTION — `source: 'worker'` is
// the claim "the crew sent this", unforgeable by a tenant because 0023 leaves
// `source`/`worker_id`/`uploaded_by` out of their column-scoped INSERT grant.
// Two copies of a claim like that would eventually disagree.

export const declareTaskDone: WorkerTool<DeclareTaskDoneInput> = {
  audience: 'worker',
  name: 'declare_task_done',
  description:
    'Record that this crew member has finished one of THEIR OWN tasks, with the photos they sent. This does NOT mark the task done — it files a claim that the manager must approve, and the task stays on their board until they do. A photo is required: call it with the waiting photo ids. If there are none, call it anyway with an empty list and this tool will tell you what to ask; it decides when a completion may be recorded without one, not you.',
  inputSchema: declareTaskDoneInput,
  execute: async (input, ctx) => {
    // ── the in-process scope check, BEFORE any query ─────────────────────────
    // ctx.scope.taskIds was computed from this worker's own open rows before
    // the model ran, and nothing the model or the worker says can widen it. A
    // uuid that is not in it never reaches the database at all — so a valid id
    // belonging to a colleague in the same company is refused without a round
    // trip, which also means it cannot be TIMED as an existence oracle.
    //
    // The three .eq() filters below are the second boundary, not the first, and
    // two of the three are values the model never supplies.
    if (!ctx.scope.taskIds.includes(input.task_id)) {
      return workerToolError('That task is not one of yours. Call my_tasks and use an id from it.');
    }

    // ── the second boundary: three filters, two of them phone-derived ────────
    // ONE query, so "no such task", "not your company" and "not assigned to
    // you" collapse into a single silent outcome with no timing difference to
    // read as an existence oracle. Same shape as the proposal-ownership read on
    // the manager's button path.
    //
    // Not redundant with the scope check above, and this is the case that
    // motivates it: `scope` was computed at the START of the turn, and the
    // manager may have reassigned or closed the task since. Without this, a
    // conversation left open while the board changed underneath would file a
    // claim against work that is no longer this person's. Everything below runs
    // on the service role, so nothing else re-checks it.
    const { data: task } = await ctx.db
      .from('tasks')
      .select('id')
      .eq('id', input.task_id)
      .eq('company_id', ctx.companyId)
      .eq('assignee_worker_id', ctx.workerId)
      .maybeSingle();
    if (!task) {
      return workerToolError('That task is not one of yours. Call my_tasks and use an id from it.');
    }

    // The photos this crew member has waiting, from `worker_photo_inbox` (0047)
    // rather than from this turn's bytes. The model has no fetch capability and
    // no way to name a photo it was not told about, so this is a consistency
    // check rather than a boundary — but it is what keeps a hallucinated id
    // from producing a claim with nothing behind it. The real boundary is
    // inside attachInboxPhotos: company_id AND worker_id, both phone-derived,
    // on the read that resolves every id below.
    const known = new Set(ctx.pendingPhotos.map(p => p.id));
    const named = [...new Set(input.photo_ids)];
    const requested = named.filter(id => known.has(id));

    // ── ids that were NAMED but resolve to nothing ───────────────────────────
    // Stale (the photo aged out of the 24-hour inbox, or an earlier claim
    // already took it) or invented. This is NOT the crew member saying they
    // have no photo — they sent one and the model is naming it wrongly — so it
    // must not spend one of the two asks. Refused, nothing recorded, and the
    // count is exactly where it was.
    if (requested.length === 0 && named.length > 0) {
      return workerToolError(
        'None of those photo ids are waiting for this worker. Ask them to send the photo again. Nothing has been recorded.',
      );
    }

    let attached = 0;
    let waivedReason: string | null = null;

    if (requested.length === 0) {
      // ── the no-photo waiver (0049) ─────────────────────────────────────────
      // Reached when this call names NO photo at all, which is the model saying
      // on the crew member's behalf that there is not one for this task.
      //
      // The decision turns on what THIS CALL NAMED, never on what happens to be
      // sitting in the inbox. `ctx.pendingPhotos` is every unattached photo
      // that person has sent in the last day, of any job or none, so keying on
      // it made the waiver unreachable for every other task until a stray photo
      // aged out — and the refusal it produced pushed the model toward filing
      // Tuesday's wall as proof of tonight's basement. Photos waiting are
      // MENTIONED below, as a fact and a question to ask, never as ids to pass
      // here.
      const cycleStartedAt = await loadClaimCycleStart(ctx.db, ctx.companyId, input.task_id);
      const attempts = await loadWaiverAttempts(ctx.db, ctx.conversationId, input.task_id);

      const decision = decidePhotoWaiver({
        attempts,
        currentInboundId: ctx.inboundMessageId,
        // False by construction here — a call that named a resolvable photo
        // took the branch below. Passed anyway so the rule lives in ONE place
        // and `pnpm waiver-check` pins the guard rather than the call site.
        hasPhotos: requested.length > 0,
        reason: input.no_photo_reason,
        cycleStartedAt,
      });

      // Written BEFORE we act on the decision, and only when this inbound
      // message has not been counted already. That "already counted" test is
      // what makes three tool calls in one turn one ask; the two unique indexes
      // in 0049 are the backstop if a read ever raced.
      if (decision.attemptNo !== null) {
        await recordWaiverAttempt(ctx.db, {
          companyId: ctx.companyId,
          workerId: ctx.workerId,
          taskId: input.task_id,
          conversationId: ctx.conversationId,
          attemptNo: decision.attemptNo,
          inboundMessageId: ctx.inboundMessageId,
        });
      }

      // ── what the refusals may and may not say about waiting photos ────────
      // They MAY state that N photos are unattached and that the crew member
      // can be asked which job those show. They may NEVER tell the model to
      // pass them for THIS task: a photo of one job filed as proof of another
      // is evidence, it is wrong, and 0023 has no DELETE policy anywhere.
      const waiting = ctx.pendingPhotos.length;
      const strays =
        waiting > 0
          ? ` Separately: ${waiting} photo(s) from this person are still unattached to any task. They are NOT proof of this task. You may ask which job they show; only pass their ids if the crew member says they are of THIS one.`
          : '';

      if (decision.outcome === 'photos') {
        return workerToolError(
          'This call named photos, so it is not a no-photo declaration. Retry with the ids you meant.',
        );
      }
      if (decision.outcome === 'ask_first') {
        return workerToolError(
          `No photo has been given for this task. Ask them for one, in one line, and stop. Nothing has been recorded.${strays}`,
        );
      }
      if (decision.outcome === 'ask_again') {
        return workerToolError(
          `Still no photo for this task. Tell them a photo is required, ask once more, and say that ANY photo of the work will do, even a dark one. Stop there. Nothing has been recorded.${strays}`,
        );
      }
      if (decision.outcome === 'need_reason') {
        return workerToolError(
          'They have been asked twice. Ask why there is no photo, in one line, then call this tool again with their own words in no_photo_reason. Do not supply a reason for them.',
        );
      }
      waivedReason = decision.reason;

      // The claim has NO proof, so the denormalised bit says UNKNOWN — never
      // 'skipped', which is the manager's own word and only the completion
      // sheet writes it. A photo that turns up later still attaches to this
      // task and the board's count picks it up at read time.
      await markTaskProofUnknown(ctx.db, ctx.companyId, input.task_id);
    } else {
      // ── photos first, claim second ─────────────────────────────────────────
      // Dying between the two leaves proof with no claim: untidy, visible, and
      // recoverable by the worker saying so again. The reverse order would
      // leave a claim with no proof, reached by a crash rather than by the two
      // asks that are the only legitimate route to it.
      //
      // Attaching MOVES each staged object into this task's folder and writes
      // the `task_photos` row, which is what makes the photo evidence. One
      // photo failing never aborts the others, and every failure logs its
      // stage.
      //
      // TWO WRITERS, and which one runs depends only on where the bytes are.
      // Almost always the inbox; `unstagedPhotos` is non-empty only when
      // staging failed, which is chiefly the window between deploying 0047 and
      // applying it. Both end at the same row-insert helper, so the attribution
      // a `source: 'worker'` row carries is written in exactly one place either
      // way. The model cannot tell the two apart and does not need to.
      const unstaged = new Map(ctx.unstagedPhotos.map(p => [p.id, p]));
      const fromInbox = requested.filter(id => !unstaged.has(id));

      if (fromInbox.length > 0) {
        const result = await attachInboxPhotos(ctx.db, {
          photoIds: fromInbox,
          taskId: input.task_id,
          companyId: ctx.companyId,
          workerId: ctx.workerId,
        });
        attached += result.attached;
      }
      for (const id of requested) {
        const photo = unstaged.get(id);
        if (!photo) continue;
        const path = await storeWorkerTaskPhoto(ctx.db, {
          companyId: ctx.companyId,
          taskId: input.task_id,
          workerId: ctx.workerId,
          photo,
        });
        if (path) attached += 1;
      }
      if (attached === 0) {
        return workerToolError('The photos could not be saved. Ask the worker to send them again.');
      }

      // The denormalised "this completion has proof" bit, written the moment
      // proof lands and BEFORE the claim below — same ordering and the same
      // reasoning as the photos themselves. The board and the inbox count
      // `task_photos` rather than reading this column, so losing it costs a
      // convenience and never the evidence.
      await markTaskProofPhotos(ctx.db, ctx.companyId, input.task_id);
    }

    // open_task_review moves the task to pending_review and files the claim in
    // ONE transaction (0018). Never two client-side updates: a half-applied
    // state — a review with the task still open, or a task in review with no
    // review row — is exactly what this feature exists to prevent.
    //
    // p_worker is ctx.workerId, phone-derived. It is what makes the claim
    // attributable, and it is not something the model can supply.
    const { data: reviewId, error } = await ctx.db.rpc('open_task_review', {
      p_task: input.task_id,
      p_worker: ctx.workerId,
      // Left OFF the payload when absent rather than sent as null: the RPC's
      // own default is null, and PostgREST types the argument as optional.
      //
      // On a waived claim the note IS the reason they gave. One column, their
      // own words, rendered to the manager as an attributed quote on every
      // surface — the same rule task_reviews.note has carried since 0018.
      p_note: waivedReason ?? input.note,
      // Absent unless it is true, so a deploy that lands before 0049 keeps
      // calling the three-argument function it has always called.
      ...(waivedReason !== null ? { p_photo_waived: true } : {}),
    });

    if (error) {
      // task_reviews_one_pending_idx (0018) is the throttle: a second
      // declaration while one is outstanding trips a unique violation. That is
      // not an error the worker caused twice — it is Capo already having their
      // claim — so it gets its own answer rather than "something went wrong".
      // Any photos above are already attached to the task either way, which is
      // the right outcome: more proof on a claim already waiting.
      const duplicate = error.code === '23505' || /task_reviews_one_pending/.test(error.message);
      return workerToolError(
        duplicate
          ? 'This task is already waiting for the manager to approve it. Tell them so, and that anything new they sent was added to it.'
          : 'Could not record the completion. Tell the worker to speak to their manager.',
      );
    }

    return {
      status: 'ok' as const,
      review_id: reviewId,
      photos_attached: attached,
      photo_waived: waivedReason !== null,
      // Model-facing, and the one thing it MUST get across: the task is not
      // done. A worker told "feito" who then sees it still on tomorrow's 07:00
      // message will conclude Capo is broken.
      //
      // On the waived branch there are two more things it must get across, and
      // they are the half of Federico's rule that faces the crew member: the
      // manager will be told there is no photo, and a photo is still required.
      // Saying it plainly is what keeps the waiver from reading as permission.
      instruction:
        waivedReason !== null
          ? 'Recorded WITHOUT a photo and sent to the manager. Tell the worker, in two short lines: it is with the manager and NOT closed; the manager will be told there is no photo and that a photo is required, and if they can send one later it will be added to this job. Do not apologise and do not lecture them.'
          : 'Recorded and sent to the manager for approval. Tell the worker briefly that it is with the manager now and NOT yet closed — never say the task is done or closed. Do not restate the photo count as a number they did not ask for.',
    };
  },
};
