// The push dispatcher: the one place a notifications row becomes a lock-screen
// alert. Called from exactly two places — immediately, via after(), from the
// request that caused the row (_tasks/actions.ts), and every 10 minutes from
// api/cron/push. ONE function, two triggers, so the two cannot drift.
//
// Sits beside inbox.ts and briefing.ts: the same subject matter — what Capo
// tells the manager — arriving through a third channel. briefing.ts is the
// 07:00 WhatsApp push, inbox.ts is the pull, this is the phone alert.
//
// THE ROW IS THE QUEUE. There is no push-specific producer and no outbound
// ledger: a notifications row with pushed_at null is an undelivered parcel.
// That is what makes "no push without an inbox entry" structural rather than a
// rule someone has to remember, and it is why #22's and #23's future
// notification kinds ride this file with no edit.
//
// SERVICE ROLE, and it is forced rather than convenient. The rows this needs
// belong to OTHER profiles — 0024's trigger specifically excludes the actor —
// so the caller's own user client structurally cannot see a single row it must
// send. The guardrails that make that acceptable: companyId only ever arrives
// from an already-authenticated requireAuth() context, never from a request
// body; and this returns void, so there is no data path back to a caller.
import { getDb } from '@capo/db/client';
import { getCatalog } from '@capo/i18n/catalog';
import { coerceLocale } from '@capo/i18n/locale';
import {
  buildPushPayload,
  decideRowState,
  PUSH_MAX_ATTEMPTS,
  type PushOutcome,
} from '@capo/core/channels/push-rules';
import { pushConfigured, sendPush, type StoredSubscription } from '@/lib/push';
import { logEvent } from '@/lib/log';

interface PendingRow {
  id: string;
  company_id: string;
  profile_id: string;
  kind: string;
  subject_type: string | null;
  subject_id: string | null;
  title: string | null;
  push_attempts: number;
}

export async function dispatchPushes(
  opts: { companyId?: string; limit?: number; olderThanSeconds?: number } = {},
): Promise<void> {
  // An unconfigured deploy is "push is off", never an error. Every preview
  // deployment is in this state.
  if (!pushConfigured()) return;

  const db = getDb();
  const limit = opts.limit ?? 200;

  let query = db
    .from('notifications')
    .select('id, company_id, profile_id, kind, subject_type, subject_id, title, push_attempts')
    .is('pushed_at', null)
    .lt('push_attempts', PUSH_MAX_ATTEMPTS)
    // Oldest first: after an outage the backlog drains in the order things
    // actually happened.
    .order('created_at', { ascending: true })
    .limit(limit);
  if (opts.companyId) query = query.eq('company_id', opts.companyId);
  // Unset (the immediate-path call from _tasks/actions.ts) means "consider
  // everything pending" — the immediate path must never skip a row it exists
  // to send right away. Set (the cron sweep) means "leave the newest rows
  // alone": this is how the sweep stays a backstop rather than a competitor —
  // a fresh row still belongs to the immediate path that just created it, and
  // the sweep only picks up what that path did not manage to deliver. There
  // is no claim protocol here; this window is what keeps the two triggers
  // from routinely double-sending the same row.
  if (opts.olderThanSeconds !== undefined) {
    query = query.lt(
      'created_at',
      new Date(Date.now() - opts.olderThanSeconds * 1000).toISOString(),
    );
  }

  const { data, error } = await query;
  if (error) {
    logEvent('notifications.push_read_failed', { error: error.message });
    return;
  }
  const rows = (data ?? []) as PendingRow[];
  if (rows.length === 0) return;

  const [taskByReview, localeByProfile, subsByProfile] = await Promise.all([
    resolveTasks(db, rows),
    resolveLocales(db, rows),
    resolveSubscriptions(db, rows),
  ]);
  // resolveSubscriptions returns null only when its own query failed. That
  // failure is indistinguishable, downstream, from "nobody in this batch has
  // registered a device" — every row would get subs = [], decideRowState([])
  // stamps every one of them, and up to `limit` notifications would be marked
  // delivered having never been sent, with no way to tell afterwards that it
  // happened. So this is the one resolver that aborts the whole run rather
  // than degrading: the rows stay pending and the next sweep (or the next
  // immediate call) tries again. resolveTasks and resolveLocales fail softer
  // — see the comments at their call sites below — because their failure
  // modes are merely lossy, not silently destructive.
  if (subsByProfile === null) return;

  let sent = 0;
  let gone = 0;
  let retried = 0;
  let skipped = 0;

  for (const row of rows) {
    const t = getCatalog(coerceLocale(localeByProfile.get(row.profile_id)));
    // The SAME catalog entry and the SAME null-title fallback the inbox
    // renders (see notificacoes/page.tsx `headline`), so push and inbox
    // structurally cannot say different things.
    const line = t.notifications.kind[row.kind as keyof typeof t.notifications.kind];
    const headline = line ? line(row.title ?? t.notifications.noSubject) : null;

    // Belt-and-braces, same posture inbox.ts and dashboard-data.ts take on
    // this identical lookup: task_reviews.company_id must match the
    // notification row's OWN company_id before the resolved task id is
    // trusted. A per-row check rather than a batch-level filter on the
    // resolveTasks query, because one dispatcher run — unlike loadInbox,
    // which is scoped to a single tenant by RLS — can span every company at
    // once. Nothing else constrains this lookup: it runs on the service role.
    const resolvedReview =
      row.subject_type === 'task_review' && row.subject_id
        ? taskByReview.get(row.subject_id)
        : undefined;
    const taskId =
      resolvedReview && resolvedReview.companyId === row.company_id ? resolvedReview.taskId : null;

    const payload = buildPushPayload({
      notificationId: row.id,
      appName: t.meta.appName,
      headline,
      taskId,
    });

    // An unrenderable kind — a row from a newer deploy reaching an older
    // bundle. During a Vercel rollout BOTH bundles serve requests at once, so
    // "unrenderable to THIS bundle" does not mean "unrenderable, full stop":
    // if an old instance's dispatch runs first and stamps the row, the new
    // bundle — whose dispatch might run on the very next request — never
    // gets the chance to push it at all, and nobody is buzzed. So this is
    // deliberately left UNSTAMPED, same as a transient send failure, rather
    // than treated as done. Left alone forever, though, that would circle
    // indefinitely after a rollback that never ships the renderer — so it is
    // bounded the same way a failed send is bounded: bumpAttempts caps it at
    // PUSH_MAX_ATTEMPTS sweeps (about 30 minutes, comfortably longer than a
    // rollout) instead of either vanishing immediately or chasing forever.
    if (!payload) {
      skipped += 1;
      await bumpAttempts(db, row);
      continue;
    }

    const subs = subsByProfile.get(row.profile_id) ?? [];
    const outcomes: PushOutcome[] = [];
    for (const sub of subs) {
      const outcome = await sendPush(sub, payload);
      outcomes.push(outcome);
      if (outcome === 'ok') sent += 1;
      if (outcome === 'gone') {
        gone += 1;
        // Believe it the first time. A registration the push service calls
        // dead will never deliver again, and retrying it forever is how this
        // table stops being small.
        const { error: deleteError } = await db
          .from('push_subscriptions')
          .delete()
          .eq('endpoint', sub.endpoint);
        if (deleteError) {
          // Not fatal to this row: worst case a dead registration lingers and
          // gets tried again next sweep, which just costs one more failed
          // send. Still worth its own line — a delete that keeps failing for
          // the same endpoint is how this table stops staying small.
          logEvent('notifications.push_subscription_delete_failed', {
            id: row.id,
            companyId: row.company_id,
            error: deleteError.message,
          });
        }
      }
      if (outcome === 'retry') {
        const { error: failError } = await db
          .from('push_subscriptions')
          .update({ last_failed_at: new Date().toISOString() })
          .eq('endpoint', sub.endpoint);
        if (failError) {
          logEvent('notifications.push_subscription_mark_failed_failed', {
            id: row.id,
            companyId: row.company_id,
            error: failError.message,
          });
        }
      }
    }

    if (decideRowState(outcomes) === 'stamp') {
      await stamp(db, row);
    } else {
      retried += 1;
      await bumpAttempts(db, row);
    }
  }

  // A run that sends nothing writes no rows and raises no error — the same
  // shape of silent failure AGENTS.md flags on the two cron send routes, where
  // it is exactly how the check-in shipped and then never sent a message.
  logEvent('notifications.push_dispatched', {
    considered: rows.length,
    sent,
    gone,
    retried,
    skipped,
    companyId: opts.companyId ?? null,
  });
}

/** Mark a row delivered. On failure this does NOT retry the write itself —
 *  see bumpAttempts below, which is what keeps a persistently failing stamp
 *  from circling forever. */
async function stamp(db: ReturnType<typeof getDb>, row: PendingRow): Promise<void> {
  const { error } = await db
    .from('notifications')
    .update({ pushed_at: new Date().toISOString() })
    .eq('id', row.id);
  if (error) {
    // The stamp IS the delivery record. If writing it fails, the row stays
    // unstamped even though the push already went out, and every future
    // sweep re-sends it to a phone that already has it — undetectably,
    // unless this is bounded the same way a failed SEND is bounded. Bumping
    // push_attempts here caps a persistently failing stamp write at
    // PUSH_MAX_ATTEMPTS sweeps instead of retrying it indefinitely.
    logEvent('notifications.push_stamp_failed', {
      id: row.id,
      companyId: row.company_id,
      error: error.message,
    });
    await bumpAttempts(db, row);
  }
}

/** Bump push_attempts for a row that was not (successfully) delivered this
 *  round — either a transient send failure, an unrenderable kind (see the
 *  comment at the `!payload` branch above), or a stamp write that itself
 *  failed. Deliberately never stamps `pushed_at` here: 0026's own comment
 *  defines an unstamped row as "an undelivered parcel", and every row that
 *  reaches this function genuinely was not delivered — stamping it would
 *  make that comment a lie about a row that just happened to run out of
 *  tries. The cost is that an abandoned row stays in
 *  notifications_push_pending_idx and gets re-read (then filtered out by the
 *  `lt('push_attempts', PUSH_MAX_ATTEMPTS)` query above) on every future
 *  sweep — the inbox and the unread strip still carry the notification
 *  either way, so the manager is un-buzzed, never uninformed. */
async function bumpAttempts(db: ReturnType<typeof getDb>, row: PendingRow): Promise<void> {
  const attempts = row.push_attempts + 1;
  const { error } = await db.from('notifications').update({ push_attempts: attempts }).eq('id', row.id);
  if (error) {
    // Worse than a failed stamp: this row now has no bound at all until the
    // NEXT sweep tries the same write again with the same push_attempts
    // value read from the DB, so it is not stuck — just undercounted for one
    // round. Logged so a write that keeps failing for the same row is at
    // least visible.
    logEvent('notifications.push_attempts_update_failed', {
      id: row.id,
      companyId: row.company_id,
      error: error.message,
    });
    return;
  }
  if (attempts >= PUSH_MAX_ATTEMPTS) {
    logEvent('notifications.push_abandoned', { id: row.id, companyId: row.company_id });
  }
}

/** Review id → (task id, company id), so the tap lands where approve/reject
 *  actually render. A second query rather than a PostgREST embed, for the
 *  same reason loadInbox avoids one: the embed alias depends on the FK
 *  constraint's generated name and a rename would break it silently.
 *
 *  company_id rides along so the call site can check it per row before
 *  trusting the resolved task id (see the belt-and-braces comment in
 *  dispatchPushes) — this query itself is deliberately NOT filtered to a
 *  single company, because one dispatcher run can span every tenant. */
async function resolveTasks(
  db: ReturnType<typeof getDb>,
  rows: PendingRow[],
): Promise<Map<string, { taskId: string; companyId: string }>> {
  const ids = [
    ...new Set(
      rows
        .filter(r => r.subject_type === 'task_review')
        .map(r => r.subject_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const map = new Map<string, { taskId: string; companyId: string }>();
  if (ids.length === 0) return map;
  const { data, error } = await db
    .from('task_reviews')
    .select('id, task_id, company_id')
    .in('id', ids);
  // Soft failure: every deep link in this batch degrades to pushTargetUrl's
  // fallback (/notificacoes), which is the CORRECT behaviour for a subject
  // that genuinely does not resolve, and merely a worse tap target — never a
  // wrong or forged one — when the cause was actually a failed query. Logged
  // so the difference is at least visible after the fact; not worth aborting
  // the run over, unlike resolveSubscriptions above.
  if (error) {
    logEvent('notifications.push_tasks_read_failed', { error: error.message });
    return map;
  }
  for (const r of data ?? []) map.set(r.id, { taskId: r.task_id, companyId: r.company_id });
  return map;
}

/** Each recipient reads their own alert in their own profiles.language — the
 *  row carries data, never copy (0024). */
async function resolveLocales(
  db: ReturnType<typeof getDb>,
  rows: PendingRow[],
): Promise<Map<string, string | null>> {
  const ids = [...new Set(rows.map(r => r.profile_id))];
  const map = new Map<string, string | null>();
  const { data, error } = await db.from('profiles').select('id, language').in('id', ids);
  // Soft failure: coerceLocale falls back to pt-PT when a profile is missing
  // from the map, so a Spanish or English manager silently gets a Portuguese
  // alert instead of none at all. A wrong-language alert still beats no
  // alert, so this does not abort the run the way resolveSubscriptions'
  // failure does — but it is worth its own log line, since nothing else
  // would otherwise record why the language was wrong.
  if (error) {
    logEvent('notifications.push_locales_read_failed', { error: error.message });
    return map;
  }
  for (const p of data ?? []) map.set(p.id, p.language);
  return map;
}

/**
 * Returns null — never an empty map — when the query itself failed. The
 * caller MUST tell those two apart: an empty map legitimately means "nobody
 * in this batch has a registered device", which is a normal, common state and
 * correctly stamps every row (0 outcomes -> decideRowState -> 'stamp'). A
 * failed query would produce the exact same empty map by accident, and
 * dispatchPushes would then stamp every row as delivered having sent
 * nothing at all — irreversibly, since pushed_at is not undone. So a failure
 * here is reported as null and dispatchPushes aborts the whole run on it,
 * rather than silently treating "the query broke" as "nobody opted in".
 */
async function resolveSubscriptions(
  db: ReturnType<typeof getDb>,
  rows: PendingRow[],
): Promise<Map<string, StoredSubscription[]> | null> {
  const ids = [...new Set(rows.map(r => r.profile_id))];
  const map = new Map<string, StoredSubscription[]>();
  const { data, error } = await db
    .from('push_subscriptions')
    .select('profile_id, endpoint, p256dh, auth')
    .in('profile_id', ids);
  if (error) {
    logEvent('notifications.push_subscriptions_read_failed', { error: error.message });
    return null;
  }
  for (const s of data ?? []) {
    const list = map.get(s.profile_id) ?? [];
    list.push({ endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth });
    map.set(s.profile_id, list);
  }
  return map;
}
