import { randomUUID } from 'node:crypto';
import type { UIMessage } from 'ai';
import type { Db } from '@capo/db/client';
import { ensureConversation, persistAssistantMessage, rowText } from '@capo/core/conversation';
import { sendWhatsAppText, type WhatsAppSendConfig } from '@capo/core/channels/whatsapp';
import { getCatalog } from '@capo/i18n/catalog';
import { LOCALES, type Locale } from '@capo/i18n/locale';
import { logEvent } from './log';

// The apology for a failed manager turn — issue #126.
//
// ── THE PROBLEM ─────────────────────────────────────────────────────────────
// On 31 Aug the model provider rejected every request for 75 minutes and a
// manager sent ten messages into total silence: the route caught each failure,
// logged it, and returned 200. The manager could not tell "Capo is broken"
// from "Capo is ignoring me" — and the escalation ("??" → "Não vais
// responder?" → "Are you alive?") was the only log anybody read. The route
// already apologises for the SMALL failure (a voice note that would not
// transcribe); this covers the total one.
//
// Free-form text inside the 24-hour window the manager's own inbound message
// opened seconds earlier — the same reasoning withProgressNote rests on
// (issue #50) — so it is free and in-window by construction. It is a plain
// send, never a model call, so it cannot loop; and it swallows every failure
// of its own, so it can never take down the catch that calls it.
//
// ── SUPPRESSION: THE THREAD IS THE STATE ────────────────────────────────────
// Ten failures must not produce ten apologies. No process memory survives
// between serverless invocations, so the suppression state lives in the
// database — and rather than a new table, it is the apology itself, persisted
// as a `role='assistant'` row in the company's chat thread. That does two
// jobs with one row:
//
//   - The thread stays HONEST (the #47 spirit): the web chat shows the same
//     apology WhatsApp delivered, and when the model comes back it sees that
//     it apologised once rather than a run of unanswered messages.
//   - "Did we already apologise?" becomes a read of the recent thread. The
//     match is content equality against this copy in EVERY locale, not just
//     the current one, so a manager who switches language mid-outage does not
//     reset the clock.
//
// An assistant row is safe where it matters: `thread.recentUserTexts` — the
// evidence pool the write guard authorizes against — filters on
// `role === 'user'`, so our own copy can never become guard evidence
// (asserted by `pnpm guard-check`).
//
// ── FAILURE ORDER ───────────────────────────────────────────────────────────
// Send first, record second. A recorded-but-unsent apology would be worse
// than either failure alone: the thread would claim the manager was told, and
// the suppression window would then silence the retries that could still
// reach them. The reverse — sent but not recorded — costs at most a repeat
// apology, which is the direction to fail in. And when the suppression READ
// itself fails (the likeliest cause being the same outage that broke the
// turn), the apology is sent anyway: during a database outage the manager may
// get one apology per message, which still beats silence.

/** How long one sent apology keeps further failures quiet. */
export const TURN_FAILURE_QUIET_MS = 15 * 60_000;

/**
 * Reply to a manager whose turn just failed, unless a recent failure already
 * got the apology. Never throws — this runs inside the catch that is the last
 * thing standing between a failed turn and total silence.
 */
export async function sendTurnFailureReply(
  db: Db,
  args: {
    companyId: string;
    messageId: string;
    locale: Locale;
    sendConfig: WhatsAppSendConfig;
  },
): Promise<void> {
  const { companyId, messageId, locale, sendConfig } = args;
  const text = getCatalog(locale).whatsapp.turnFailed;

  let conversationId: string | null = null;
  try {
    conversationId = await ensureConversation(db, companyId);
    const cutoff = new Date(Date.now() - TURN_FAILURE_QUIET_MS).toISOString();
    // The window bounds the scan, the limit only caps a pathological burst.
    // Newest-first, so if an apology IS in the window it sits near the top;
    // and during an outage — the case this exists for — apologies are the
    // only assistant rows there are.
    const { data, error } = await db
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .eq('role', 'assistant')
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(30);
    if (error) throw new Error(error.message);
    const apologies = new Set(LOCALES.map(l => getCatalog(l).whatsapp.turnFailed));
    if ((data ?? []).some(row => apologies.has(rowText(row)))) {
      logEvent('whatsapp.turn_failure_reply', {
        companyId,
        conversationId,
        messageId,
        outcome: 'suppressed',
      });
      return;
    }
  } catch (err) {
    // Fail toward sending: an unreadable thread must not buy the manager more
    // silence. conversationId may still be null here, which skips the record
    // below — apologies then repeat per message until the read recovers.
    logEvent('whatsapp.turn_failure_reply', {
      companyId,
      conversationId,
      messageId,
      outcome: 'state_unavailable',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    await sendWhatsAppText(text, sendConfig);
  } catch (err) {
    // Nothing reached the manager, so nothing is recorded: a thread row for a
    // message that never arrived would also arm the suppression window against
    // the next attempt that might get through.
    logEvent('whatsapp.turn_failure_reply', {
      companyId,
      conversationId,
      messageId,
      outcome: 'send_failed',
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }
  logEvent('whatsapp.turn_failure_reply', { companyId, conversationId, messageId, outcome: 'sent' });

  if (!conversationId) return;
  try {
    const message: UIMessage = {
      id: randomUUID(),
      role: 'assistant',
      parts: [{ type: 'text', text }],
    };
    await persistAssistantMessage(db, conversationId, message, 'whatsapp');
  } catch (err) {
    logEvent('whatsapp.turn_failure_reply', {
      companyId,
      conversationId,
      messageId,
      outcome: 'record_failed',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
