import { after } from 'next/server';
import { getDb } from '@capo/db/client';
import { coerceLocale, type Locale } from '@capo/i18n/locale';
import { logEvent } from '../../lib/log';
import { resolveDayLink, noteDayLinkOpened } from '../../lib/day-link';
import { fanOutTasks, type BriefingTask } from '../notifications/briefing';

// The read behind /dia (issue #114).
//
// ── THE ENTIRE TENANT BOUNDARY IS THE TOKEN ROW ────────────────────────────
// There is no session here. The visitor is an anonymous browser holding a
// string, so `auth.uid()` is null, RLS enforces NOTHING, and every read below
// runs on the SERVICE ROLE. What keeps one company's board out of another's is
// that `resolveDayLink` returns a (company_id, worker_id) pair minted by the
// cron — never anything from the URL beyond the opaque token — and every query
// is filtered on that pair.
//
// Same shape and same reasoning as handleCheckinTap's notification_log read and
// the guided menu's loadWorkerTasks. In particular: the worker id is never taken
// from the query string, and there is no second parameter that could widen what
// a token reaches. A token is one person's day and nothing else.

/** Tasks a crew member should be told about — the briefing's own allowlist. */
const BRIEFABLE = new Set(['pending', 'in_progress']);

/**
 * A crew member's day, or null when the token does not resolve.
 *
 * `null` covers unknown, expired, malformed and unreadable alike — the page
 * renders one sentence for all four. See resolveDayLink for why they are not
 * distinguished.
 */
export interface WorkerDay {
  name: string;
  locale: Locale;
  /** Lisbon's today, as the database answers it — never computed here. */
  today: string;
  /**
   * Work whose window includes today: exactly the tasks the 07:00 message
   * names, through exactly the same fan-out.
   */
  today_tasks: BriefingTask[];
  /**
   * Work whose deadline has already passed.
   *
   * ── THE REASON THIS PAGE EXISTS ─────────────────────────────────────────
   * `task_board.active_today` is `today between window_start and
   * coalesce(due_date, 'infinity')` (0013), so a task that is late has
   * `active_today = false` and appears in NEITHER daily WhatsApp send. The
   * manager sees it on the board under Atrasadas; the person who has to do it
   * has never been told. This bucket is the first surface that tells them.
   *
   * Filtered on `is_open` (task_board's denylist) rather than on BRIEFABLE, so
   * a late task already declared finished still shows — marked as waiting on
   * the manager rather than vanishing. Same asymmetry the guided menu makes,
   * and for the same reason: a task that disappears reads as a system that lost
   * it.
   */
  overdue_tasks: BriefingTask[];
}

/**
 * Resolve a token into one crew member's day.
 *
 * ── ONE BOARD READ, THE SAME ONE THE BRIEFING MAKES ────────────────────────
 * Reads every open `task_board` row for the company and fans it out through
 * `fanOutTasks`, which is the function `loadCompanyBriefing` uses. Issue #114
 * asks for exactly this: the page must not re-query the board with rules of its
 * own, because the failure it would cause is Capo saying one thing in WhatsApp
 * and this page saying another, with the crew member having no way to tell
 * which is right.
 *
 * Two buckets fall out of that one read: `active_today && BRIEFABLE` (what the
 * message says) and `overdue` (what it structurally cannot). The buckets differ;
 * the definition of a task does not.
 *
 * `select('*')`, not a column list, so a deploy landing before a migration that
 * appends a view column degrades rather than 42703s (AGENTS.md).
 */
export async function loadWorkerDay(token: string | null): Promise<WorkerDay | null> {
  const db = getDb();

  const link = await resolveDayLink(db, token);
  if (!link) return null;

  const [{ data: worker, error: workerError }, { data: company, error: companyError }, { data: today }] =
    await Promise.all([
      db
        .from('workers')
        .select('*')
        .eq('id', link.workerId)
        // Belt and braces: resolveDayLink already pairs the two, and 0039's
        // trigger refuses a row that pairs them wrongly. Re-asserted here
        // because this is the query whose result decides what gets rendered.
        .eq('company_id', link.companyId)
        .maybeSingle(),
      db.from('companies').select('language').eq('id', link.companyId).maybeSingle(),
      db.rpc('lisbon_today'),
    ]);

  if (workerError || !worker) {
    // A live token whose worker is gone is not an error the visitor can act on,
    // and it is indistinguishable to them from an expired link. Logged because
    // it should not happen: nothing deletes a crew row today.
    logEvent('day_link.worker_missing', { company_id: link.companyId, error: workerError?.message });
    return null;
  }
  if (companyError) logEvent('day_link.company_read_failed', { error: companyError.message });

  const { data: rows, error: boardError } = await db
    .from('task_board')
    .select('*')
    .eq('company_id', link.companyId)
    .eq('is_open', true);
  if (boardError) throw new Error(`task_board read failed: ${boardError.message}`);

  const open = rows ?? [];
  const todays = fanOutTasks(open.filter(r => r.active_today === true && BRIEFABLE.has(r.status ?? '')));
  const lates = fanOutTasks(open.filter(r => r.overdue === true));

  // Counted, never gated on, and never on the synchronous path: this is
  // bookkeeping, and a crew member standing on a building site must not wait a
  // round trip for a counter. after() runs it once the response has flushed.
  if (token) after(noteDayLinkOpened(db, token));

  return {
    name: worker.name,
    // NULL means "inherit the company" — the third dial (AGENTS.md). Resolved
    // the same way loadCompanyBriefing resolves it, so the page and the message
    // are in one language.
    locale: worker.language ? coerceLocale(worker.language) : coerceLocale(company?.language ?? null),
    today: typeof today === 'string' ? today : '',
    today_tasks: todays.get(link.workerId) ?? [],
    overdue_tasks: lates.get(link.workerId) ?? [],
  };
}
