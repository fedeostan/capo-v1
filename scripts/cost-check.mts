// Cost ledger check — the deterministic half of the QA gate for issue #53.
// Needs NO credentials, no network and no database, so it runs in CI on every
// PR. Sibling of scheduler-check.mts, guard-check.mts, whatsapp-check.mts,
// push-check.mts and cache-check.mts.
//
// It guards four failures, every one of which is SILENT in production — a cost
// dashboard that is wrong does not throw, it just quietly misinforms:
//
//   1. DOUBLE-COUNTING CACHED TOKENS. The AI SDK reports `inputTokens.total`
//      INCLUDING the cached halves. Storing that in `input_tokens` alongside
//      `cache_read_tokens` bills every cached prompt token twice — and since
//      #58 turned caching on, that is most of the conversation traffic. The
//      resulting number is plausible, larger than reality, and unfalsifiable
//      without this check.
//   2. AN UNPRICED MODEL COSTING ZERO. A model swapped into models.ts without a
//      line in pricing.ts would make the whole bill appear to fall.
//   3. THE CACHE MULTIPLIERS DRIFTING from the 1.25x / 0.1x that cache.ts's
//      whole break-even argument rests on.
//   4. THE SURFACE LIST DRIFTING from the CHECK constraint in migration 0032.
//      Two edits are required and only one is enforced by tsc; the other shows
//      up as a surface that silently records nothing.
//
// Run with `pnpm cost-check`. Exit 0 = green, 1 = at least one failure.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { Db } from '@capo/db/client';
import { MODEL_IDS, MODEL_PROVIDERS, type ModelRole } from '@capo/core/models';
import {
  managerOrSystem,
  toTokenBuckets,
  usageRecordingMiddleware,
  type UsageRecord,
  type UsageSurface,
} from '@capo/core/agent/usage';
import {
  ANTHROPIC_CACHE_READ_MULTIPLIER,
  ANTHROPIC_CACHE_WRITE_MULTIPLIER,
  MODEL_PRICES,
  estimateCostUsd,
  estimateUncachedCostUsd,
  formatUsd,
} from '@capo/core/agent/pricing';

let failures = 0;
const lines: string[] = [];

function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures += 1;
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function eq(name: string, actual: unknown, expected: unknown) {
  check(name, actual === expected, `got ${String(actual)}, want ${String(expected)}`);
}

function close(name: string, actual: number, expected: number) {
  check(name, Math.abs(actual - expected) < 1e-9, `got ${actual}, want ${expected}`);
}

// ── 1. the provider payload → four disjoint buckets ────────────────────────
//
// The shapes below are the real `LanguageModelV4Usage` the AI SDK hands the
// middleware, written out by hand so this assertion does not depend on the
// provider agreeing with itself.
{
  // A cached Anthropic request mid-conversation: most of the prompt is served
  // from cache, a little is new. `total` is the SUM of all three.
  const cached = toTokenBuckets({
    inputTokens: { total: 5300, noCache: 300, cacheRead: 5000, cacheWrite: 0 },
    outputTokens: { total: 120 },
  });
  eq('cached request: input is the NON-cached half only', cached.input, 300);
  eq('cached request: cache read is carried separately', cached.cacheRead, 5000);
  eq('cached request: cache write is zero', cached.cacheWrite, 0);
  eq('cached request: output', cached.output, 120);
  eq(
    'cached request: the three input buckets sum back to the reported total',
    cached.input + cached.cacheRead + cached.cacheWrite,
    5300,
  );
}

{
  // The FIRST request of a turn: the prefix is written into the cache.
  const firstWrite = toTokenBuckets({
    inputTokens: { total: 5300, noCache: 300, cacheRead: 0, cacheWrite: 5000 },
    outputTokens: { total: 90 },
  });
  eq('cache-write request: input is the non-cached half only', firstWrite.input, 300);
  eq('cache-write request: cache write is carried separately', firstWrite.cacheWrite, 5000);
}

{
  // Google, and every uncached Anthropic role: no breakdown at all. The
  // fallback must put the whole prompt in `input` rather than losing it.
  const flat = toTokenBuckets({ inputTokens: { total: 900 }, outputTokens: { total: 40 } });
  eq('no cache breakdown: the whole prompt is full-price input', flat.input, 900);
  eq('no cache breakdown: cache read is zero', flat.cacheRead, 0);
  eq('no cache breakdown: cache write is zero', flat.cacheWrite, 0);
}

{
  // A provider that reports nothing, and one that reports nonsense. Neither may
  // produce NaN, a negative, or a fraction — the columns are non-negative
  // integers with CHECK constraints, and a rejected insert is a SILENT loss.
  const empty = toTokenBuckets({});
  eq('missing usage: input is 0', empty.input, 0);
  eq('missing usage: output is 0', empty.output, 0);

  const contradictory = toTokenBuckets({
    inputTokens: { total: 100, cacheRead: 400, cacheWrite: 0 },
    outputTokens: { total: -5 },
  });
  check('contradictory usage never goes negative', contradictory.input === 0, `got ${contradictory.input}`);
  eq('negative output is clamped to 0', contradictory.output, 0);

  const fractional = toTokenBuckets({ inputTokens: { total: 10.7 }, outputTokens: { total: 3.2 } });
  check('fractional token counts are rounded to integers', Number.isInteger(fractional.input));
  check('fractional output is rounded to an integer', Number.isInteger(fractional.output));
}

// ── 2. every model the registry can produce has a price ────────────────────
for (const [role, id] of Object.entries(MODEL_IDS) as [ModelRole, string][]) {
  check(
    `MODEL_IDS.${role} (${id}) has a line in the rate card`,
    id in MODEL_PRICES,
    'an unpriced model silently costs ZERO on the dashboard',
  );
  check(`MODEL_PROVIDERS.${role} is set`, MODEL_PROVIDERS[role] === 'anthropic' || MODEL_PROVIDERS[role] === 'google');
}
eq('MODEL_PROVIDERS covers exactly the roles MODEL_IDS does',
  Object.keys(MODEL_PROVIDERS).sort().join(','),
  Object.keys(MODEL_IDS).sort().join(','));

// An unknown model must be reported as UNPRICED, never as free.
{
  const unknown = estimateCostUsd('claude-does-not-exist', {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  });
  eq('an unknown model is flagged unpriced', unknown.priced, false);
  eq('an unknown model reports confidence "unpriced"', unknown.confidence, 'unpriced');
  eq('an unknown model does not quietly cost 0 with priced=true', unknown.usd, 0);
}

// ── 3. the arithmetic, on numbers checkable by hand ────────────────────────
{
  // Sonnet 5 at $3 in / $15 out per MTok. One million of each bucket.
  const cost = estimateCostUsd('claude-sonnet-5', {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_tokens: 1_000_000,
    cache_write_tokens: 1_000_000,
  });
  // 3 + 15 + (3 * 0.1) + (3 * 1.25) = 3 + 15 + 0.3 + 3.75
  close('Sonnet 5: four buckets priced at four different rates', cost.usd, 22.05);
  eq('Sonnet 5 is a published price', cost.confidence, 'published');
}

{
  const price = MODEL_PRICES['claude-sonnet-5'];
  close('cache READ is 0.1x input', price.cacheReadUsdPerMTok, price.inputUsdPerMTok * 0.1);
  close('cache WRITE is 1.25x input', price.cacheWriteUsdPerMTok, price.inputUsdPerMTok * 1.25);
}
eq('the read multiplier cache.ts argues from is 0.1', ANTHROPIC_CACHE_READ_MULTIPLIER, 0.1);
eq('the write multiplier cache.ts argues from is 1.25', ANTHROPIC_CACHE_WRITE_MULTIPLIER, 1.25);

{
  // The saving claim on the dashboard. A prefix read from cache nine times
  // after one write must cost LESS than paying full input ten times, or the
  // whole of #58 is a loss and the page would be reporting a negative saving.
  const tokens = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 9_000_000,
    cache_write_tokens: 1_000_000,
  };
  const withCache = estimateCostUsd('claude-sonnet-5', tokens).usd;
  const without = estimateUncachedCostUsd('claude-sonnet-5', tokens).usd;
  check('caching one write + nine reads beats paying full price ten times', withCache < without,
    `${formatUsd(withCache)} vs ${formatUsd(without)}`);
  // 9 * 0.3 + 1 * 3.75 = 6.45 against 10 * 3 = 30.
  close('the cached figure is exact', withCache, 6.45);
  close('the uncached comparison prices every prompt token at the input rate', without, 30);
}

{
  // The uncached comparison must NOT double-count either: total prompt tokens
  // are input + cacheRead + cacheWrite, priced once each at the input rate.
  const flat = estimateUncachedCostUsd('claude-sonnet-5', {
    input_tokens: 1_000_000,
    output_tokens: 0,
    cache_read_tokens: 1_000_000,
    cache_write_tokens: 1_000_000,
  }).usd;
  close('uncached comparison prices 3M prompt tokens once each', flat, 9);
}

// ── 4. the surface list agrees with migration 0032 ─────────────────────────
//
// The TypeScript union and the SQL CHECK constraint are two hand-written
// statements of one list. tsc pins the first; nothing pins the second, and a
// surface missing from the constraint records NOTHING at all — the insert is
// rejected and the rejection is deliberately swallowed.
{
  const here = dirname(fileURLToPath(import.meta.url));
  const sql = readFileSync(join(here, '..', 'supabase', 'migrations', '0032_ai_usage.sql'), 'utf8');
  const block = /surface text not null check \(surface in \(([\s\S]*?)\)\)/.exec(sql);
  check('0032 declares a surface CHECK constraint', block != null);

  if (block) {
    const inSql = [...block[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]).sort();
    // Written out rather than derived from the type: a union is erased at
    // runtime, so listing it here is what makes the two sides comparable at
    // all. Adding a surface therefore fails HERE until all three are updated.
    const inTs: UsageSurface[] = [
      'manager_chat',
      'worker_chat',
      'summarizer',
      'planner',
      'translation',
      'transcription',
      'vocab_extraction',
    ];
    eq('0032 CHECK lists exactly the UsageSurface union', inSql.join(','), [...inTs].sort().join(','));
    check('there is no "briefing" surface (the daily sends call no model)', !inSql.includes('briefing'));
  }

  // The token columns must be four, separate, and non-negative — the shape the
  // whole double-counting argument depends on.
  for (const column of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens']) {
    check(`0032 declares ${column} with a non-negative CHECK`,
      sql.includes(`${column} integer not null default 0 check (${column} >= 0)`));
  }
  check('0032 stores no currency column', !/\b(cost|usd|price|amount)_?\w*\s+(numeric|decimal|money)/i.test(sql),
    'prices go stale; the ledger stores tokens and nothing else');
  check('0032 stamps usage_date from lisbon_today(), not from the caller',
    sql.includes('usage_date date not null default lisbon_today()'));
  check('0032 keeps usage_date OUT of the tenant INSERT grant',
    /grant insert \(([\s\S]*?)\) on table ai_usage/.test(sql) &&
      !/grant insert \(([\s\S]*?)usage_date([\s\S]*?)\) on table ai_usage/.test(sql));
  check('0032 grants tenants no SELECT on ai_usage',
    !/grant select[^;]*\bai_usage\b/i.test(sql),
    'cross-company cost belongs to the operator app, on the service role');
}

// ── 5. the middleware itself, driven for real ──────────────────────────────
//
// Everything above tests pure functions. This drives the actual middleware the
// model seam installs, against a fake `doStream`/`doGenerate` and a fake insert,
// because the two things most likely to go wrong here are behavioural rather
// than arithmetic:
//
//   - the STREAM side must forward every part unchanged and in order. It sits
//     upstream of the `.tee()` in both agent cores, so a transform that dropped,
//     reordered or stalled a part would break the conversation itself — the
//     worst possible failure for a metrics feature.
//   - a failing insert must NOT propagate. `recordUsage` swallows by contract;
//     if it ever stopped, a database hiccup would take down a live turn.

/** A `Db` stand-in that records what would have been inserted. */
function fakeDb() {
  const inserted: Record<string, unknown>[] = [];
  let mode: 'ok' | 'error' | 'throw' = 'ok';
  const db = {
    from() {
      return {
        async insert(row: Record<string, unknown>) {
          if (mode === 'throw') throw new Error('connection reset');
          inserted.push(row);
          return mode === 'error' ? { error: { message: 'permission denied' } } : { error: null };
        },
      };
    },
  };
  return {
    inserted,
    db: db as unknown as Db,
    fail: (m: 'error' | 'throw') => {
      mode = m;
    },
  };
}

function recordFor(db: Db): UsageRecord {
  return {
    db,
    companyId: 'c-1',
    surface: 'manager_chat',
    actor: { kind: 'manager', profileId: 'p-1' },
    modelRole: 'conversation',
    modelId: 'claude-sonnet-5',
    provider: 'anthropic',
  };
}

const STREAM_PARTS = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: '0' },
  { type: 'text-delta', id: '0', delta: 'Bom ' },
  { type: 'text-delta', id: '0', delta: 'dia' },
  { type: 'text-end', id: '0' },
  {
    type: 'finish',
    finishReason: 'stop',
    usage: {
      inputTokens: { total: 5300, noCache: 300, cacheRead: 5000, cacheWrite: 0 },
      outputTokens: { total: 120 },
    },
  },
];

/* eslint-disable @typescript-eslint/no-explicit-any */
async function drive(mw: ReturnType<typeof usageRecordingMiddleware>, parts: unknown[]) {
  const doStream = async () => ({
    stream: new ReadableStream({
      start(controller) {
        for (const p of parts) controller.enqueue(p);
        controller.close();
      },
    }),
    request: { body: 'sentinel' },
  });
  const out = await (mw.wrapStream as any)({ doStream, doGenerate: async () => ({}), params: {}, model: {} });
  const seen: any[] = [];
  const reader = (out.stream as ReadableStream).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen.push(value);
  }
  return { seen, out };
}

{
  const { db, inserted } = fakeDb();
  const { seen, out } = await drive(usageRecordingMiddleware(recordFor(db)), STREAM_PARTS);

  eq('stream: every part is forwarded', seen.length, STREAM_PARTS.length);
  eq(
    'stream: parts arrive in the original order, unmodified',
    seen.map(p => p.type).join(','),
    STREAM_PARTS.map(p => p.type).join(','),
  );
  eq('stream: text content is untouched', seen[2].delta + seen[3].delta, 'Bom dia');
  eq('stream: non-stream fields of the result are passed through', (out as any).request?.body, 'sentinel');

  eq('stream: exactly one usage row is written per request', inserted.length, 1);
  const row = inserted[0] ?? {};
  eq('stream row: company', row.company_id, 'c-1');
  eq('stream row: actor', row.actor, 'manager');
  eq('stream row: profile_id set', row.profile_id, 'p-1');
  eq('stream row: worker_id null on a manager row', row.worker_id, null);
  eq('stream row: surface', row.surface, 'manager_chat');
  eq('stream row: model id', row.model_id, 'claude-sonnet-5');
  eq('stream row: full-price input only', row.input_tokens, 300);
  eq('stream row: cache read', row.cache_read_tokens, 5000);
  eq('stream row: output', row.output_tokens, 120);
  check('stream row: no currency field is ever sent', !('cost' in row) && !('usd' in row));
  check('stream row: usage_date is NOT sent (the DB stamps it)', !('usage_date' in row));
}

{
  // A worker turn: the union must produce worker_id and a null profile_id, i.e.
  // the exact shape 0032's actor CHECK requires.
  const { db, inserted } = fakeDb();
  const record: UsageRecord = {
    ...recordFor(db),
    surface: 'worker_chat',
    actor: { kind: 'worker', workerId: 'w-1' },
  };
  await drive(usageRecordingMiddleware(record), STREAM_PARTS);
  eq('worker row: actor', inserted[0]?.actor, 'worker');
  eq('worker row: worker_id set', inserted[0]?.worker_id, 'w-1');
  eq('worker row: profile_id null', inserted[0]?.profile_id, null);
}

{
  // A stream that ends without a `finish` part (an aborted or errored response)
  // must forward everything and write nothing, rather than writing zeroes.
  const { db, inserted } = fakeDb();
  const { seen } = await drive(usageRecordingMiddleware(recordFor(db)), STREAM_PARTS.slice(0, 3));
  eq('aborted stream: parts still forwarded', seen.length, 3);
  eq('aborted stream: no usage row invented', inserted.length, 0);
}

{
  // An all-zero report is not worth a row — the provider omits usage on some
  // error responses, and four zeroes would skew every average on the dashboard.
  const { db, inserted } = fakeDb();
  await drive(usageRecordingMiddleware(recordFor(db)), [
    { type: 'finish', finishReason: 'error', usage: { inputTokens: {}, outputTokens: {} } },
  ]);
  eq('empty usage report writes no row', inserted.length, 0);
}

{
  // THE CONTRACT THAT MATTERS MOST. A ledger write that fails must not surface.
  // Both shapes: an error object back from PostgREST, and a thrown exception.
  const rejected = fakeDb();
  rejected.fail('error');
  let threw = false;
  try {
    await drive(usageRecordingMiddleware(recordFor(rejected.db)), STREAM_PARTS);
  } catch {
    threw = true;
  }
  check('a REJECTED ledger insert never breaks the stream', !threw);

  const broken = fakeDb();
  broken.fail('throw');
  let threw2 = false;
  let forwarded = 0;
  try {
    const { seen } = await drive(usageRecordingMiddleware(recordFor(broken.db)), STREAM_PARTS);
    forwarded = seen.length;
  } catch {
    threw2 = true;
  }
  check('a THROWN ledger failure never breaks the stream', !threw2);
  eq('and every part still reached the reader', forwarded, STREAM_PARTS.length);
}

{
  // The generate side (generateText / generateObject): same row, and the
  // model's own result is returned untouched.
  const { db, inserted } = fakeDb();
  const mw = usageRecordingMiddleware(recordFor(db));
  const result = await (mw.wrapGenerate as any)({
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'ok' }],
      finishReason: 'stop',
      usage: { inputTokens: { total: 900 }, outputTokens: { total: 40 } },
    }),
    doStream: async () => ({}),
    params: {},
    model: {},
  });
  eq('generate: the model result is passed through unchanged', result.content[0].text, 'ok');
  eq('generate: one usage row', inserted.length, 1);
  eq('generate: an unbroken-down prompt is all full-price input', inserted[0]?.input_tokens, 900);
  eq('generate: output', inserted[0]?.output_tokens, 40);
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── 6. formatting ──────────────────────────────────────────────────────────
eq('zero formats as $0', formatUsd(0), '$0');
eq('sub-cent keeps four decimals', formatUsd(0.0012), '$0.0012');
eq('a few dollars keeps two', formatUsd(1.239), '$1.24');
eq('tens round to whole dollars', formatUsd(1234.5), '$1235');
// The caching saving is the one figure that can legitimately go negative (the
// 1.25x writes not being repaid), and it must not render as "$-1.23".
eq('a negative saving reads as -$1.23', formatUsd(-1.23), '-$1.23');
eq('a negative sub-cent saving keeps four decimals', formatUsd(-0.0012), '-$0.0012');

// ── 7. managerOrSystem ─────────────────────────────────────────────────────
// ToolContext.userId is nullable (null when a tool runs from an approved
// proposal). Inventing a profile id there would put a fabricated name on a bill.
eq('a real profile id bills the person', managerOrSystem('p-9').kind, 'manager');
eq('a null user bills the company, not a made-up person', managerOrSystem(null).kind, 'system');
eq('undefined behaves the same as null', managerOrSystem(undefined).kind, 'system');
eq('an empty string is not a profile id', managerOrSystem('').kind, 'system');

console.log(lines.join('\n'));
console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
