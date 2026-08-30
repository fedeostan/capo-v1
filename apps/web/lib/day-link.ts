import { randomBytes } from 'node:crypto';
import type { Db } from '@capo/db/client';
import { logEvent } from './log';
import { siteUrl } from './site-url';

// The crew day link — minting one end, resolving the other (issue #114).
//
// Everything here treats the token as what it is: a BEARER CREDENTIAL that
// travels through WhatsApp in plain text and then sits in a chat log on a phone
// that gets passed around a van. See supabase/migrations/0039_worker_day_links.sql
// for why it is a row rather than a signature.
//
// Both halves run on the SERVICE-ROLE client, and that is not an oversight:
// there is no `auth.uid()` anywhere on this path — the minter is a Vercel Cron
// invocation and the reader is an anonymous browser — so RLS enforces NOTHING
// here. The tenant boundary is the token row itself: it names one company and
// one worker, and every read the page performs is filtered on both. Same shape
// and same reasoning as handleCheckinTap's notification_log read and the guided
// menu's loadWorkerTasks (AGENTS.md).

/**
 * Bytes of entropy per token.
 *
 * 32 bytes → 43 base64url characters. Well past guessing, and short enough that
 * the URL still fits on one line of a WhatsApp message next to the domain,
 * which matters: a link that wraps reads as broken.
 */
const TOKEN_BYTES = 32;

/** The query parameter the page reads. */
export const DAY_LINK_PARAM = 't';

function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * The offset Europe/Lisbon is running at, in minutes ahead of UTC, at a given
 * instant. 0 in winter, +60 in summer.
 *
 * Derived from Intl rather than hard-coded, for the same reason `lisbon_today()`
 * lives in SQL: Portugal's clock is a political fact, not an arithmetic one, and
 * a hard-coded +1 would be silently wrong for five months of the year.
 */
function lisbonOffsetMinutes(at: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Lisbon',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? '0');
  // `hour` comes back as 24 for midnight under hour12:false in some ICU
  // versions; % 24 normalises it to the 0 that Date.UTC expects.
  const asIfUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );
  return (asIfUtc - at.getTime()) / 60_000;
}

/**
 * The instant the Lisbon day AFTER `today` begins — i.e. exactly when `today`
 * stops being today for `lisbon_today()`, and therefore when a link minted for
 * `today` must stop working.
 *
 * ── WHY THE EXPIRY IS A DAY BOUNDARY AND NOT A DURATION ────────────────────
 * Issue #114 settles what a leaked link may expose: TODAY ONLY. The page reads
 * the LIVE board rather than a snapshot — which is right, because a crew member
 * tapping at 16:00 needs the afternoon's truth, not the morning's — but it means
 * a token that outlives its day would go on exposing tomorrow's work, and the
 * day after's, for as long as it lasts. "48 hours" would be a duration that
 * quietly widens the promise. A boundary keeps it literally true.
 *
 * `today` is `lisbon_today()`'s own answer, passed in rather than recomputed, so
 * the token and the board agree about which day this is by construction (one
 * clock, AGENTS.md).
 *
 * The cost, stated rather than hidden: a link tapped after midnight is dead, and
 * the next one does not arrive until 07:00. That is a real gap of a few hours
 * for a night shift, and it is the price of the "today only" rule.
 */
export function lisbonDayEnd(today: string): Date {
  const next = new Date(`${today}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  // Local midnight is `next` pulled back by whatever offset Lisbon is running.
  // Evaluated AT the guess and then once more at the result: the two differ only
  // across a DST transition, and Lisbon's transitions happen at 01:00 UTC, so
  // one refinement is provably enough. Asserted season by season in
  // scripts/scheduler-check.mts.
  const firstPass = new Date(next.getTime() - lisbonOffsetMinutes(next) * 60_000);
  return new Date(next.getTime() - lisbonOffsetMinutes(firstPass) * 60_000);
}

/**
 * The URL a crew member taps.
 *
 * `/dia` — "day" — deliberately short and deliberately Portuguese, sitting
 * beside /tarefas and /obras rather than under an /api or /w prefix: this is a
 * page a person reads, and the address is the first thing they see of it.
 */
export function dayLinkUrl(token: string): string {
  return `${siteUrl().replace(/\/+$/, '')}/dia?${DAY_LINK_PARAM}=${encodeURIComponent(token)}`;
}

/**
 * Mint (or re-read) today's link for each of these crew members: one write and
 * one read for the whole company, never one per person.
 *
 * ── IDEMPOTENT BY CONSTRAINT, NOT BY CHECKING FIRST ────────────────────────
 * Two invocations pass the send window every day (#51), and both reach this
 * function before either knows whether it won its notification_log claim. So the
 * write is an upsert with `ignoreDuplicates` against
 * `worker_day_links_worker_date_idx`: the second invocation's rows are refused
 * by the index, the first one's tokens stay the ones in circulation, and nobody
 * ends up holding two live credentials for the same day.
 *
 * Reading first and inserting only what is missing would race between those two
 * ticks and produce exactly that. Which is why the WRITE is not the source of
 * truth for what was minted — the SELECT after it is. Whichever invocation wrote
 * the rows, both read the same tokens back and both would render the same links.
 *
 * ── IT NEVER THROWS ────────────────────────────────────────────────────────
 * A link is one extra line on a message. A crew member must never lose their
 * 07:00 briefing because this table was missing, a grant was revoked, or the
 * migration had not landed yet — so every failure is swallowed into one
 * greppable `day_link.mint_failed` line and the caller renders the briefing
 * without the link, exactly as it did before this feature existed. Same posture
 * as recordThreadEvent, recordCronRun and recordUsage.
 *
 * The cost of that posture, stated rather than hidden: a broken mint presents as
 * messages that quietly stop carrying the link. Grep that event before
 * concluding nobody uses the page.
 */
export async function mintDayLinks(
  db: Db,
  args: { companyId: string; workerIds: string[]; today: string },
): Promise<Map<string, string>> {
  const links = new Map<string, string>();
  if (args.workerIds.length === 0) return links;

  const expiresAt = lisbonDayEnd(args.today).toISOString();

  try {
    const { error: writeError } = await db.from('worker_day_links').upsert(
      args.workerIds.map(workerId => ({
        token: newToken(),
        company_id: args.companyId,
        worker_id: workerId,
        link_date: args.today,
        expires_at: expiresAt,
      })),
      { onConflict: 'worker_id,link_date', ignoreDuplicates: true },
    );
    if (writeError) throw new Error(writeError.message);

    const { data, error: readError } = await db
      .from('worker_day_links')
      .select('token, worker_id')
      .eq('company_id', args.companyId)
      .eq('link_date', args.today)
      .in('worker_id', args.workerIds);
    if (readError) throw new Error(readError.message);

    for (const row of data ?? []) {
      if (row.token && row.worker_id) links.set(row.worker_id, row.token);
    }
  } catch (err) {
    logEvent('day_link.mint_failed', {
      company_id: args.companyId,
      workers: args.workerIds.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return new Map();
  }

  return links;
}

/** Who a presented token belongs to. */
export interface ResolvedDayLink {
  companyId: string;
  workerId: string;
}

/**
 * Resolve a token presented by an anonymous browser.
 *
 * ── ONE OUTCOME FOR EVERY REFUSAL ──────────────────────────────────────────
 * Unknown, expired, malformed and unreadable all return `null`, and the page
 * renders one sentence for all four. That is deliberate: distinguishing "this
 * token never existed" from "this token has expired" tells somebody holding a
 * guessed string whether they guessed a real one, and there is nothing a crew
 * member can do differently with the distinction anyway — the answer in both
 * cases is "wait for tomorrow's message".
 *
 * ── THE TTL IS ENFORCED HERE, AND NOTHING SWEEPS THE TABLE ─────────────────
 * Same rule as checkin_photo_requests (#52): a sweep that fails leaves live
 * credentials behind and says nothing, whereas a reader that checks cannot. An
 * unparseable `expires_at` reads as EXPIRED, never as valid — the fail-closed
 * direction, and the only one that is safe for a credential.
 */
export async function resolveDayLink(db: Db, token: string | null): Promise<ResolvedDayLink | null> {
  // Bounded before it reaches the database: `token` is raw query-string input,
  // and an unbounded value has no business being sent as a lookup key.
  if (!token || token.length < 32 || token.length > 128) return null;

  const { data, error } = await db
    .from('worker_day_links')
    .select('company_id, worker_id, expires_at')
    .eq('token', token)
    .maybeSingle();

  if (error) {
    logEvent('day_link.read_failed', { error: error.message });
    return null;
  }
  if (!data?.company_id || !data.worker_id) return null;

  const expiresAt = Date.parse(data.expires_at ?? '');
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return null;

  return { companyId: data.company_id, workerId: data.worker_id };
}

/**
 * Record that the link was opened. Bookkeeping only — nothing gates on it.
 *
 * A cap on opens would be the obvious next thought and is the wrong one: a crew
 * member who checks their list six times has done nothing wrong, and WhatsApp
 * itself fetches a previewed URL, so the first "open" is frequently not a
 * person at all. What this answers is "does anybody use this page", which is
 * the question that decides whether the feature earns a second version.
 *
 * Swallows its own failure, for the same reason the mint does: nobody's day
 * gets a 500 because a counter would not increment.
 */
export async function noteDayLinkOpened(db: Db, token: string): Promise<void> {
  const { error } = await db.rpc('note_day_link_opened', { p_token: token });
  if (error) logEvent('day_link.open_note_failed', { error: error.message });
}
