import {
  mayNarrateProgress,
  PROGRESS_NOTE_AFTER_MS,
  sendReadReceipt,
  type WhatsAppApiConfig,
} from '@capo/core/channels/whatsapp';
import { logEvent } from './log';

// "Capo is working on it", for WhatsApp — issue #50.
//
// ── THE PROBLEM ─────────────────────────────────────────────────────────────
// The web chat tells the manager something is happening: a "Capo está a
// escrever…" line, and a chip per tool call. WhatsApp told them nothing at all.
// They sent a message and watched a blank screen for ten to thirty seconds,
// which reads as "it broke" — so they send it again, which costs another whole
// agent turn and can produce a second approval card for the same intent.
//
// ── WHY NOT "SEND A MESSAGE AND THEN EDIT IT" ───────────────────────────────
// Because there is no such thing. The WhatsApp Cloud API has exactly ONE
// messages endpoint and it is send-only: no edit, no update, no delete, for any
// message a business sends. The idea is a good one and it is simply not
// available. What IS available is two status updates, and between them they
// cover most of the gap:
//
//   read receipt      the two blue ticks. "Your message arrived."
//   typing indicator  "…" under the business name. Expires after 25 SECONDS,
//                     or the moment the real reply is sent, whichever is first.
//
// Both ride ONE request (Meta's endpoint takes `status: 'read'` with an
// optional `typing_indicator`), and neither is a message — no `type`, no
// `template`, no recipient field, and no message id in the response.
//
// ── THE MONEY RULE ──────────────────────────────────────────────────────────
// Meta bills TEMPLATE messages. Everything in this file is either a status
// update (not a message, cannot be billed as a template) or free-form text sent
// inside the 24-hour window the recipient's own inbound message opened (free by
// Meta's own pricing documentation). Nothing here may ever call
// sendWhatsAppTemplate, and nothing here does. A status update that cost money
// would be strictly worse than no status update at all.
//
// ── AND WHY THERE IS NO KEEP-ALIVE ──────────────────────────────────────────
// The obvious next idea — re-send the typing indicator every 20 seconds so it
// never lapses — is deliberately NOT here. A repeating timer on a serverless
// function is a bug generator: the instance can freeze the instant the response
// flushes, so the loop dies mid-cycle or holds the function open for nothing.
// The answer to a turn outlasting 25 seconds is ONE plain-text progress note,
// sent from a single timer that is always cleared, which is what
// withProgressNote below does.

/**
 * Tell the sender we have their message — and, when an answer is genuinely
 * coming, that we are working on it.
 *
 * NEVER THROWS. Feedback that breaks the answer is worse than no feedback, so
 * every failure is logged and swallowed: a Graph hiccup here must not cost the
 * manager their reply.
 *
 * `typing` is required rather than defaulted because Meta asks that the
 * indicator only be shown when a reply is actually intended, and because the
 * honest answer differs per path: an agent turn takes seconds and earns one, a
 * button tap answered from a lookup does not.
 *
 * NOT called for an UNRESOLVED sender, and that omission is a security property
 * rather than an oversight. Two blue ticks are an answer: they would confirm to
 * a stranger that their message reached a live system, which is exactly what
 * the webhook's silent no-op for unknown senders exists to refuse.
 */
export async function acknowledgeInbound(
  messageId: string,
  config: WhatsAppApiConfig,
  options: { typing: boolean; companyId?: string },
): Promise<void> {
  try {
    await sendReadReceipt(messageId, config, { typing: options.typing });
  } catch (err) {
    logEvent('whatsapp.receipt_failed', {
      companyId: options.companyId,
      messageId,
      typing: options.typing,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** What became of the one progress note a turn is allowed. */
export type ProgressNoteOutcome = 'sent' | 'outside_window' | 'failed';

/**
 * Run a turn, and if it is still running after `delayMs`, send ONE plain-text
 * "still working on it".
 *
 * This exists because the typing indicator expires after 25 seconds and
 * vanishes without a word. A plan or a translation routinely runs longer, so
 * the exact turns where the manager most needs reassurance were the ones that
 * went silent again halfway through.
 *
 * ── WHY THIS TIMER IS SAFE AND A KEEP-ALIVE IS NOT ─────────────────────────
 * It is a SINGLE setTimeout, created and cleared inside one awaited call. The
 * caller is inside Next's `after()`, which keeps the invocation alive until its
 * callback settles, so the timer never outlives the request — and the `finally`
 * clears it on every exit, including a throw. There is no interval, no
 * recursion, and nothing left scheduled once this returns.
 *
 * ── THE 24-HOUR WINDOW, ASSERTED RATHER THAN ASSUMED ───────────────────────
 * `inboundAt` is when the webhook was received. The message that arrived then
 * is what opened Meta's free-form window, so the note is free — but
 * mayNarrateProgress is consulted anyway, because a free-form send outside the
 * window is refused (131047) and the recovery path for that refusal is a PAID
 * template. Assumed-safe is how a status update turns into a bill.
 *
 * ── KNOWN, SMALL, AND STATED ───────────────────────────────────────────────
 * If the turn happens to finish in the same few milliseconds the timer fires,
 * the note can land AFTER the answer instead of before it. `settled` closes
 * every case except that exact interleave, which is cosmetic — a stray "still
 * on it" under a completed reply — and not worth serialising the whole sink to
 * remove.
 */
export async function withProgressNote<T>(
  work: () => Promise<T>,
  note: {
    /** When the inbound webhook arrived — the proof of the free-form window. */
    inboundAt: number;
    send: () => Promise<void>;
    report: (outcome: ProgressNoteOutcome, error?: string) => void;
    delayMs?: number;
  },
): Promise<T> {
  let settled = false;
  // Held so the finally can await it: a send left in flight when the after()
  // callback resolves would be cut off mid-request, and an unhandled rejection
  // from it would escape where nothing is listening.
  let inFlight: Promise<void> | undefined;

  const timer = setTimeout(() => {
    if (settled) return;
    if (!mayNarrateProgress(note.inboundAt, Date.now())) {
      // Not reachable on today's paths — the inbound message is seconds old.
      // Reported rather than ignored so that if it ever DOES happen, the reason
      // the note went missing is in the log instead of being inferred.
      note.report('outside_window');
      return;
    }
    inFlight = note.send().then(
      () => note.report('sent'),
      err => note.report('failed', err instanceof Error ? err.message : String(err)),
    );
  }, note.delayMs ?? PROGRESS_NOTE_AFTER_MS);

  try {
    return await work();
  } finally {
    settled = true;
    clearTimeout(timer);
    // Both outcomes are already handled above, so this can never reject.
    if (inFlight) await inFlight;
  }
}
