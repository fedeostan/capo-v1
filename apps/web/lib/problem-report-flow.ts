import type { Db } from '@capo/db/client';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import { sendWhatsAppText, type WhatsAppSendConfig } from '@capo/core/channels/whatsapp';
import { clampReportText, reportRequestExpiry, reportRequestLive } from './problem-report';
import { reportCommand } from './worker-keywords';
import { logEvent } from './log';

// The WhatsApp half of "report a problem" (issue #120), for BOTH sender kinds.
//
// ── WHY THIS RUNS IN FRONT OF BOTH AGENTS, DETERMINISTICALLY ────────────────
// The issue's own words: when someone reports that Capo is behaving badly, the
// last thing that should decide whether the report is filed is Capo behaving
// well. On 31 Aug (issue #126) the model provider rejected every request for
// 75 minutes — that is precisely the moment a manager types "bug", and this
// path answers it with zero model calls. On the manager branch it sits above
// handleInbound; on the worker branch it sits with the other keyword tables,
// above the restricted agent.
//
// ── THE BOUNDARY: REPORT TEXT IS MAIL TO THE OPERATOR, NOT CONVERSATION ─────
// A report is untrusted free text — especially from crew — and it is written
// to `problem_reports` and NOWHERE ELSE. Never `messages` (the write guard's
// evidence pool, 0027/AGENTS.md), never `worker_messages`, never a thread
// note, never a log line. Both call sites return before their agent runs, so
// a consumed message is never persisted to any conversation table. The
// isolation matrix seeds its worker tracer through a report and sweeps the
// manager-context tables for it.
//
// ── FAILURE POSTURE ─────────────────────────────────────────────────────────
// A keyword command, once recognised, is ALWAYS consumed: if filing or arming
// fails (the likeliest cause being 0042 not yet applied), the sender gets the
// "could not register it" apology rather than having the model take over the
// exact message that says the model is misbehaving. The armed-capture read is
// the opposite: any failure there reads as "not armed" and the message falls
// through to the agents — byte-identical to the pre-#120 product.

export type ReportSender =
  | { audience: 'manager'; companyId: string; profileId: string }
  | { audience: 'worker'; companyId: string; workerId: string };

/** The columns that scope a staging row to its sender, for reads and writes alike. */
function senderKeys(sender: ReportSender): { worker_id: string | null; profile_id: string | null } {
  return sender.audience === 'worker'
    ? { worker_id: sender.workerId, profile_id: null }
    : { worker_id: null, profile_id: sender.profileId };
}

/** Which column scopes a staging row to this sender, for the two filtered queries below. */
function senderColumn(sender: ReportSender): ['worker_id' | 'profile_id', string] {
  return sender.audience === 'worker' ? ['worker_id', sender.workerId] : ['profile_id', sender.profileId];
}

/**
 * File one report. Returns false when the insert failed — the caller decides
 * whether to apologise (a command) or leave the staging row open (a capture,
 * so the sender's retry is still caught).
 *
 * The text is clamped, never refused: a WhatsApp message can be twice the
 * column's CHECK bound, and losing a long report to a 23514 is the failure
 * this feature exists to end. `via` records which door it came through —
 * useful to the operator, invisible to the reporter.
 */
async function fileReport(
  db: Db,
  sender: ReportSender,
  text: string,
  locale: Locale,
  messageId: string,
  via: 'inline' | 'armed',
): Promise<boolean> {
  // NO `.select()` chained, deliberately, even though the service role could:
  // this mirrors the app form's tenant-side insert (write-only table, 0042)
  // so the two writers stay the same shape.
  const { error } = await db.from('problem_reports').insert({
    company_id: sender.companyId,
    ...senderKeys(sender),
    channel: 'whatsapp',
    text: clampReportText(text),
    // Attached by US — nothing here was typed by the sender. The message id is
    // Meta's wamid, which lets the operator correlate a report with the
    // webhook logs without the report ever quoting anything.
    context: { source: 'whatsapp', message_id: messageId, locale, via },
  });
  if (error) {
    // Expected, and survivable, on any deploy landing before 0042: 42P01.
    logEvent('problem_report.file_failed', {
      companyId: sender.companyId,
      audience: sender.audience,
      via,
      error: error.message,
      code: error.code,
    });
    return false;
  }
  logEvent('problem_report.filed', {
    companyId: sender.companyId,
    audience: sender.audience,
    channel: 'whatsapp',
    via,
  });
  return true;
}

/** Arm "your next message is the report": supersede any open row, insert a fresh one. */
async function armReport(db: Db, sender: ReportSender): Promise<boolean> {
  // Close whatever this sender had open first. The partial unique indexes
  // (0042) make a second open row a 23505, so this sweep is what keeps a
  // repeated "bug" from failing rather than re-arming.
  const [column, value] = senderColumn(sender);
  const sweep = await db
    .from('problem_report_requests')
    .update({ closed_at: new Date().toISOString(), close_reason: 'superseded' })
    .eq(column, value)
    .is('closed_at', null);
  if (sweep.error) {
    logEvent('problem_report.stage_failed', {
      companyId: sender.companyId,
      audience: sender.audience,
      stage: 'sweep',
      error: sweep.error.message,
    });
    return false;
  }

  const { error } = await db.from('problem_report_requests').insert({
    company_id: sender.companyId,
    ...senderKeys(sender),
    expires_at: reportRequestExpiry(Date.now()),
  });
  if (error) {
    logEvent('problem_report.stage_failed', {
      companyId: sender.companyId,
      audience: sender.audience,
      stage: 'insert',
      error: error.message,
    });
    return false;
  }
  logEvent('problem_report.armed', { companyId: sender.companyId, audience: sender.audience });
  return true;
}

/**
 * Handle one inbound TEXT message for the report flow. Returns true when the
 * message was consumed — a keyword command, or the armed next-message — and
 * the sender has been answered; false to fall through to whatever the caller
 * would otherwise do with it.
 *
 * Never throws, and never lets the report text travel anywhere but
 * `problem_reports.text`.
 */
export async function handleProblemReportMessage(
  db: Db,
  sender: ReportSender,
  text: string,
  locale: Locale,
  sendConfig: WhatsAppSendConfig,
  messageId: string,
): Promise<boolean> {
  const t = getCatalog(locale).whatsapp;
  const say = async (body: string) => {
    await sendWhatsAppText(body, sendConfig).catch(err => {
      logEvent('problem_report.ack_failed', {
        companyId: sender.companyId,
        audience: sender.audience,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };

  // ── a keyword command: always consumed, whatever happens next ─────────────
  const command = reportCommand(text);
  if (command) {
    try {
      if (command.kind === 'inline') {
        const filed = await fileReport(db, sender, command.text, locale, messageId, 'inline');
        await say(filed ? t.reportAck : t.reportFailed);
        return true;
      }
      const armed = await armReport(db, sender);
      await say(armed ? t.reportPrompt : t.reportFailed);
    } catch (err) {
      logEvent('problem_report.flow_failed', {
        companyId: sender.companyId,
        audience: sender.audience,
        error: err instanceof Error ? err.message : String(err),
      });
      await say(t.reportFailed);
    }
    return true;
  }

  // ── the armed next-message ────────────────────────────────────────────────
  // Any failure between here and a live row reads as "not armed": the message
  // falls through to the agents, which is the pre-#120 product. Scoped by the
  // sender's OWN resolved id — phone/BSUID-derived, never anything from the
  // message body — and the partial unique indexes make this at most one row.
  try {
    const [column, value] = senderColumn(sender);
    const { data: request, error } = await db
      .from('problem_report_requests')
      .select('id, expires_at')
      .eq(column, value)
      .is('closed_at', null)
      .maybeSingle();
    if (error) {
      // Expected on any deploy landing before 0042: 42P01.
      logEvent('problem_report.read_failed', {
        companyId: sender.companyId,
        audience: sender.audience,
        error: error.message,
      });
      return false;
    }
    if (!request) return false;

    if (!reportRequestLive(request.expires_at, Date.now())) {
      await db
        .from('problem_report_requests')
        .update({ closed_at: new Date().toISOString(), close_reason: 'abandoned' })
        .eq('id', request.id);
      return false;
    }

    const filed = await fileReport(db, sender, text, locale, messageId, 'armed');
    if (!filed) {
      // The row stays OPEN on purpose: the sender was promised their next
      // message would be registered, filing it failed, and the apology asks
      // them to try again — so the retry must still be caught.
      await say(t.reportFailed);
      return true;
    }

    const { error: closeError } = await db
      .from('problem_report_requests')
      .update({ closed_at: new Date().toISOString(), close_reason: 'filed' })
      .eq('id', request.id);
    if (closeError) {
      // The report IS filed; a row that failed to close costs at most one
      // later message captured as a duplicate report, which the TTL bounds.
      logEvent('problem_report.close_failed', {
        companyId: sender.companyId,
        audience: sender.audience,
        error: closeError.message,
      });
    }
    await say(t.reportAck);
    return true;
  } catch (err) {
    logEvent('problem_report.flow_failed', {
      companyId: sender.companyId,
      audience: sender.audience,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
