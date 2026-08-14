import { NextResponse, type NextRequest } from 'next/server';
import { getDb } from '@capo/db/client';
import { coerceLocale } from '@capo/i18n/locale';
import { findConversation } from '@capo/core/conversation';
import { consolidateCompanyMemory } from '@capo/core/memory/consolidate';
import { MEMORY_READ_LIMIT, memoryVisibleTo } from '@capo/core/memory/prompt';
import {
  authorizeCron,
  billableCompanies,
  CONSOLIDATE_HOUR,
  CONSOLIDATE_WINDOW_HOURS,
  readLisbonClock,
  withinSendWindow,
} from '@/lib/cron';
import { logEvent } from '@/lib/log';

// ── THE NIGHTLY MEMORY REVIEW (issue #48) ───────────────────────────────────
//
// Once a night, per paying company, a second agent re-reads the MANAGER's own
// thread since it last ran and writes down what should still be known in three
// months. The reasoning behind the whole feature — why memories are capped, why
// this cannot write names, why it must never read a worker's text — lives in
// packages/core/src/agent/memory/consolidate.ts, next to the code that enforces
// it. What lives here is the schedule and the claim.
//
// ── THIS ROUTE SENDS NOTHING, AND SEVERAL RULES THEREFORE DO NOT APPLY ─────
// No Meta template, no WhatsApp, no notification_log row, no consent question,
// no cron_runs row. It spends MODEL tokens and nothing else, which is why:
//   * it is not on /perfil/automacoes — that screen is about messages sent to
//     people, each costing money per recipient and each needing the manager's
//     decision. Putting a background chore there would make an internal job look
//     like something the crew receives, and `company_schedules.job_kind` is
//     CHECKed to the two sends precisely so that cannot happen by accident;
//   * `billableCompanies` still gates it. Inference is money too, and a company
//     that has stopped paying must not keep running up a nightly bill — the same
//     reasoning as the worker agent's daily budget.
//
// ── THE HOUR GATE, AND WHY IT IS SAFE HERE ────────────────────────────────
// See CONSOLIDATE_HOUR in lib/cron.ts. Short version: three Lisbon hours wide
// (02–04, ending before the earliest hour a manager may aim a send at), and the
// watermark makes a missed night cost lateness instead of loss.
//
// SYSTEM path: no user session, service-role client, acts across tenants. Its
// structural gate is the CRON_SECRET bearer, which Vercel injects on its own
// scheduled invocations. There is no auth.uid() here, so RLS covers nothing and
// the company_id → conversation_id lookup below is the entire tenant boundary
// for the thread read.

export const dynamic = 'force-dynamic';

// One model call per company, serially. 300s is the same ceiling the two send
// routes use; MAX_COMPANIES_PER_RUN below is what keeps a run inside it.
export const maxDuration = 300;

/**
 * Companies one invocation will attempt.
 *
 * The three in-window ticks ARE the batching: each takes up to this many
 * unclaimed companies, and the unique key on (company_id, run_date) means the
 * next tick picks up whoever is left rather than repeating anybody. At 25 that
 * is 75 companies a night with no change, and widening the window or the
 * schedule is the lever if the estate outgrows it.
 */
const MAX_COMPANIES_PER_RUN = 25;

export async function GET(request: NextRequest) {
  const denied = authorizeCron(request);
  if (denied) {
    // Without this, a rotated CRON_SECRET looks byte-identical in the logs to a
    // healthy night on which nothing was worth remembering: both write nothing
    // and raise nothing. Same reason the sibling routes log their rejection.
    logEvent('consolidate.cron_denied', { status: denied.status });
    return denied;
  }

  const db = getDb();

  const clock = await readLisbonClock(db, 'consolidate');
  if (!clock) return new NextResponse('clock unavailable', { status: 500 });

  if (!withinSendWindow(clock.hour, CONSOLIDATE_HOUR, CONSOLIDATE_WINDOW_HOURS)) {
    // A rejected gate writes no row and raises no error, which is exactly how
    // the check-in shipped and then never sent a single message. This line is
    // what makes "the night shift never runs" falsifiable.
    logEvent('consolidate.out_of_window', { hour: clock.hour, target: CONSOLIDATE_HOUR });
    return NextResponse.json({ ok: true, skipped: 'out_of_window', hour: clock.hour });
  }

  const companies = await billableCompanies(db);

  let attempted = 0;
  let written = 0;
  let failures = 0;

  for (const company of companies) {
    if (attempted >= MAX_COMPANIES_PER_RUN) break;

    // ── the claim ──────────────────────────────────────────────────────────
    // BEFORE the model call, and with covers_until_at deliberately null. Four
    // ticks pass the gate every night; `unique (company_id, run_date)` is what
    // makes the second, third and fourth no-ops by construction (23505), the
    // same device notification_log's key is for the sends. Dying between the
    // claim and the stamp costs one night and advances nothing — the reverse
    // order is the one that loses a window silently.
    const { data: claim, error: claimError } = await db
      .from('memory_consolidations')
      .insert({ company_id: company.id, run_date: clock.today, status: 'pending' })
      .select('id')
      .single();
    if (claimError) {
      if (claimError.code !== '23505') {
        logEvent('consolidate.claim_failed', { companyId: company.id, error: claimError.message });
      }
      continue;
    }

    attempted += 1;

    try {
      const result = await runForCompany(db, company.id, company.language);

      const { error: stampError } = await db
        .from('memory_consolidations')
        .update({
          status: result.status,
          covers_until_at: result.coversUntilAt,
          messages_read: result.messagesRead,
          memories_written: result.written,
          completed_at: new Date().toISOString(),
        })
        .eq('id', claim.id);
      if (stampError) {
        // The work is done and the memories are stored; only the bookkeeping
        // failed. Left as 'pending' with no watermark, which means tomorrow
        // re-reads the same window — wasteful, never wrong, and greppable.
        logEvent('consolidate.stamp_failed', { companyId: company.id, error: stampError.message });
      }

      written += result.written;
      logEvent('consolidate.company_done', {
        companyId: company.id,
        status: result.status,
        messagesRead: result.messagesRead,
        written: result.written,
        rejectedDuplicate: result.rejected.duplicate,
        rejectedName: result.rejected.name,
        rejectedInvalid: result.rejected.invalid,
      });
    } catch (err) {
      failures += 1;
      const message = err instanceof Error ? err.message : String(err);
      // Recorded as failed with NO watermark, which is what makes tomorrow
      // night cover both days. One company failing must never abort the rest —
      // the same rule the check-in's per-task claim loop follows.
      await db
        .from('memory_consolidations')
        .update({ status: 'failed', error: message.slice(0, 500), completed_at: new Date().toISOString() })
        .eq('id', claim.id);
      logEvent('consolidate.company_failed', { companyId: company.id, error: message });
    }
  }

  logEvent('consolidate.swept', {
    hour: clock.hour,
    companies: companies.length,
    attempted,
    written,
    failures,
  });
  return NextResponse.json({ ok: true, attempted, written, failures });
}

/** One company's night: resolve the thread, read the watermark, consolidate. */
async function runForCompany(
  db: ReturnType<typeof getDb>,
  companyId: string,
  companyLanguage: string,
) {
  // The tenant boundary for the thread read. `messages` has no company_id — it
  // scopes through its conversation — so this lookup is what proves the rows
  // belong to this company. Never take a conversation id from anywhere else on
  // this path.
  const conversationId = await findConversation(db, companyId);
  if (!conversationId) {
    return {
      status: 'empty' as const,
      messagesRead: 0,
      written: 0,
      coversUntilAt: null,
      rejected: { duplicate: 0, name: 0, invalid: 0 },
    };
  }

  // The newest SUCCEEDED watermark, not the newest row: a failed or skipped
  // night must not be able to advance it. `covers_until_at is not null` is the
  // predicate, because that column is stamped nowhere else.
  const { data: watermark } = await db
    .from('memory_consolidations')
    .select('covers_until_at')
    .eq('company_id', companyId)
    .not('covers_until_at', 'is', null)
    .order('covers_until_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const [{ data: memoryRows }, { data: profiles }, { data: company }] = await Promise.all([
    db
      .from('memories')
      .select('*')
      .eq('company_id', companyId)
      .eq('active', true)
      .order('created_at', { ascending: false })
      .limit(MEMORY_READ_LIMIT),
    db.from('profiles').select('full_name').eq('company_id', companyId),
    db.from('companies').select('name').eq('id', companyId).single(),
  ]);

  // Company-scoped memories only (profileId null), which is exactly the set this
  // pass may add to — a personal memory is not its business and showing it one
  // would leak a colleague's note into a prompt.
  //
  // The WHOLE visible set, not the capped window: consolidateCompanyMemory
  // deduplicates against all of it and shows the model only the window. A fact
  // that has fallen out of the window is still stored, and re-writing it would
  // create a duplicate that then displaces the original.
  const existing = (memoryRows ?? []).filter(row => memoryVisibleTo(row, null));

  // Issue #62's guard list: every name that is a database row somebody can
  // change from a form. Workers are deliberately absent — see
  // mentionsForbiddenName.
  const forbiddenNames = [
    ...(profiles ?? []).map(p => p.full_name).filter((n): n is string => typeof n === 'string' && n.length > 0),
    ...(company?.name ? [company.name] : []),
  ];

  return consolidateCompanyMemory({
    db,
    companyId,
    conversationId,
    since: watermark?.covers_until_at ?? null,
    // companies.language: memories are STORED data, and the company dial is the
    // one that governs stored data (AGENTS.md's three dials).
    companyLocale: coerceLocale(companyLanguage),
    forbiddenNames,
    existing,
  });
}
