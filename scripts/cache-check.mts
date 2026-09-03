// Prompt-caching check — the deterministic half of issue #58.
//
// Provider prompt caching is the one optimisation in this repo that fails
// COMPLETELY SILENTLY in both directions. A breakpoint in the wrong place does
// not error: it quietly writes a cache entry nobody ever reads, and the bill
// goes UP by 25% on the marked span rather than down by 90%. A breakpoint that
// stops being emitted at all does not error either — the product just gets
// gradually more expensive with no signal anywhere. Nothing in `next build`,
// `tsc` or ESLint can see any of it.
//
// So this file asserts the four things that would each be invisible:
//
//   1. THE PROMPT DID NOT CHANGE. Cutting the system prompt in two is only
//      safe if the two halves joined back together are byte-identical to the
//      single string that used to be sent. Asserted against the real manager
//      and worker prompt builders, per locale.
//   2. THE CUT IS ABOVE THE DATE LINE. The cached half must contain nothing
//      dated, nothing counted and nothing read out of a tenant's rows. A
//      breakpoint below today's date caches a prefix that is guaranteed stale
//      tomorrow — full price, every day, forever.
//   3. THE MARKERS SURVIVE TO THE WIRE. The last block drives the real
//      `@ai-sdk/anthropic` provider against a stubbed `fetch` and reads the
//      request body it would have posted, checking that `cache_control` lands
//      on the last tool definition and on the first system block and NOWHERE
//      else. A pure-function check alone would keep passing if somebody
//      dropped `withToolCacheBreakpoint` from the agent loop.
//   4. THE CACHED PREFIX CLEARS THE MODEL'S MINIMUM. Anthropic refuses to
//      cache a prefix below a per-model floor — silently, with
//      `cache_creation_input_tokens: 0`. The floor is NOT monotonic across
//      generations (Sonnet 5: 1024; Haiku 4.5: 4096), which is exactly why the
//      summarizer/extraction/translation roles are deliberately uncached.
//
// Like `pnpm scheduler-check`, `pnpm guard-check` and `pnpm whatsapp-check`
// (and unlike `pnpm agent-smoke`) this needs NO credentials, no network and no
// model call, so it runs in CI on every PR.
//
// Run with `pnpm cache-check`. Exit 0 = green, 1 = at least one failure.

import type { Db } from '@capo/db/client';
import type { Locale, LocaleContext } from '@capo/i18n/locale';
import {
  CACHE_BREAKPOINT,
  MAX_CACHE_BREAKPOINTS,
  PROMPT_BLOCK_SEPARATOR,
  cachedInstructions,
  joinBlocks,
  withToolCacheBreakpoint,
} from '@capo/core/agent/cache';
import { buildSystemPrompt, managerStableBlocks } from '@capo/core/agent/context';
import { buildWorkerSystemPrompt, workerStableBlocks } from '@capo/core/agent/worker-context';
import type { WorkerIdentity } from '@capo/core/agent/worker-context';
import { CACHED_ROLES, MIN_CACHEABLE_PREFIX_TOKENS, MODEL_IDS, getModel } from '@capo/core/models';
import {
  MEMORY_PROMPT_MAX_CHARS,
  MEMORY_PROMPT_ROWS,
  memoryVisibleTo,
  selectPromptMemories,
} from '@capo/core/memory/prompt';
import { toAiTools } from '@capo/core/capabilities';
import { toWorkerAiTools } from '@capo/core/capabilities/worker';
import type { ToolContext } from '@capo/core/capabilities/types';
import type { WorkerContext } from '@capo/core/capabilities/worker';

// ── harness ─────────────────────────────────────────────────────────────────
const lines: string[] = [];
let failures = 0;

function check(label: string, ok: boolean, detail?: string): void {
  lines.push(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failures++;
}
function eq<T>(label: string, actual: T, expected: T): void {
  check(label, Object.is(actual, expected), `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

const LOCALES: Locale[] = ['pt-PT', 'es-ES', 'en-US'];

/**
 * Chars per token used to turn a measured prompt length into a token estimate
 * WITHOUT calling the token-counting API (this check takes no credentials).
 *
 * Deliberately pessimistic. Prose in these languages runs around 3.5–4 chars
 * per token; assuming 5 means the estimate UNDER-counts, so "this prefix
 * clears the 1024-token floor" is a claim the real tokenizer can only make
 * safer, never break. Never raise this to make an assertion pass.
 */
const CHARS_PER_TOKEN = 5;
const estTokens = (text: string) => Math.floor(text.length / CHARS_PER_TOKEN);

/**
 * A `Db` that answers every query with a canned row set, so the REAL prompt
 * builders can run with no database. Chained builder calls (`.select().eq()…`)
 * return the same thenable, and awaiting it yields the table's fixture.
 */
function stubDb(fixtures: Record<string, unknown>): Db {
  const chain = (table: string): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) =>
              resolve(fixtures[table] ?? { data: null, error: null, count: 0 });
          }
          return () => chain(table);
        },
      },
    );
  return {
    from: (table: string) => chain(table),
    rpc: () => Promise.resolve({ data: null, error: null }),
  } as unknown as Db;
}

const db = stubDb({
  // `onboarded_at` set: an established tenant, so the manager prompt carries the
  // ordinary blocks. The onboarding CHECKLIST fixture is the separate stub
  // below, because its whole point is that it appears under the breakpoint.
  companies: {
    data: { name: 'Construções Silva', onboarded_at: '2026-01-01T00:00:00Z', about: 'Remodelações' },
    error: null,
  },
  // The manager's own name (issue #62). A per-PROFILE fact, so it belongs
  // strictly below the breakpoint: above it, the cached prefix would stop being
  // shared between two managers of the same company and would be rewritten on
  // every rename.
  profiles: { data: { full_name: 'Aníbal Gatsby' }, error: null },
  jobs: { count: 3, error: null },
  workers: { count: 7, error: null },
  tasks: { count: 12, error: null },
  proposals: { count: 1, error: null },
  // Three rows covering the three cases #48 introduces: a company memory (the
  // only shape that existed before 0037), one belonging to THIS manager, and one
  // belonging to a colleague. The third is the assertion that matters — on the
  // WhatsApp path the client is the service role, so RLS is bypassed and
  // `selectPromptMemories`' filter is the only thing keeping a colleague's
  // private note out of this manager's context.
  memories: {
    data: [
      { kind: 'preference', content: 'Prefere obras a norte', created_at: '2026-01-02T00:00:00Z', profile_id: null },
      { kind: 'preference', content: 'Trata-me por tu', created_at: '2026-01-03T00:00:00Z', profile_id: 'profile-1' },
      { kind: 'preference', content: 'SEGREDO DO COLEGA', created_at: '2026-01-04T00:00:00Z', profile_id: 'profile-2' },
    ],
    error: null,
  },
  knowledge_documents: {
    data: [{ title: 'Impermeabilização de coberturas', category: 'técnicas' }],
    error: null,
  },
});

// ── 1. the split is byte-identical to the prompt we used to send ────────────
{
  const stable = ['A', 'B'];
  const volatile = ['C', null, 'D'];
  const legacy = [...stable, ...volatile].filter(Boolean).join(PROMPT_BLOCK_SEPARATOR);

  const msgs = cachedInstructions(stable, volatile);
  eq('cachedInstructions returns exactly two system messages', msgs.length, 2);
  eq('the first half carries the breakpoint', msgs[0]?.providerOptions, CACHE_BREAKPOINT);
  eq('the second half carries none', msgs[1]?.providerOptions, undefined);
  eq(
    'rejoined, the two halves reproduce the old single-string prompt byte for byte',
    [msgs[0]?.content, msgs[1]?.content].join(PROMPT_BLOCK_SEPARATOR),
    legacy,
  );

  const onlyStable = cachedInstructions(['A'], [null, undefined]);
  eq('an empty volatile half emits one message, still cached', onlyStable.length, 1);
  eq('and it keeps the breakpoint', onlyStable[0]?.providerOptions, CACHE_BREAKPOINT);

  const onlyVolatile = cachedInstructions([], ['C']);
  eq('an empty stable half emits one message', onlyVolatile.length, 1);
  eq('and spends NO breakpoint on it', onlyVolatile[0]?.providerOptions, undefined);
  eq('cachedInstructions of nothing emits nothing', cachedInstructions([], []).length, 0);
}

// ── 2. the real prompts: identical text, and the cut is above the date ──────
//
// These markers are the things that MUST stay below the breakpoint. Each is a
// different kind of volatility: the clock, the tenant's counts, the tenant's
// rows, the individual PROFILE (issue #62 — a name above the line would
// fragment the cached prefix per manager), and the conversation itself.
const VOLATILE_MARKERS = [
  "Today's date",
  'Construções Silva',
  'Aníbal Gatsby',
  'Prefere obras a norte',
  // The dashboard address (migration 0046). It comes from the DEPLOYMENT, not
  // from the code: a preview build and production would warm different cached
  // prefixes if it sat above the line.
  'https://www.construcapo.com',
  // A per-PROFILE memory (issue #48). Below the line for the same reason the
  // manager's name is: above it, each manager of one company would warm a
  // separate cached prefix, and every memory written at 03:00 would invalidate
  // it — the textbook "breakpoint on content that changes every request".
  'Trata-me por tu',
];

for (const locale of LOCALES) {
  const locales: LocaleContext = { user: locale, company: locale };
  const msgs = await buildSystemPrompt({
    db,
    companyId: 'company-1',
    userId: 'profile-1',
    appUrl: 'https://www.construcapo.com',
    summary: 'Resumo anterior da conversa.',
    locales,
  });

  eq(`manager/${locale}: two system messages`, msgs.length, 2);
  eq(`manager/${locale}: breakpoint on the first`, msgs[0]?.providerOptions, CACHE_BREAKPOINT);
  eq(`manager/${locale}: none on the second`, msgs[1]?.providerOptions, undefined);

  const cached = msgs[0]?.content ?? '';
  const uncached = msgs[1]?.content ?? '';

  eq(
    `manager/${locale}: the cached half is exactly persona ⊕ policy ⊕ language directive`,
    cached,
    joinBlocks(managerStableBlocks(locales)),
  );
  for (const marker of VOLATILE_MARKERS) {
    check(`manager/${locale}: "${marker}" stays BELOW the breakpoint`, !cached.includes(marker) && uncached.includes(marker));
  }
  check(
    `manager/${locale}: the conversation summary stays below the breakpoint`,
    !cached.includes('Resumo anterior da conversa.') && uncached.includes('Resumo anterior da conversa.'),
  );
  check(
    `manager/${locale}: the language-directive carve-out survives the split intact`,
    cached.includes('manager_instruction'),
  );
  // Issue #48. A colleague's PERSONAL memory must appear in neither half. It is
  // asserted here, in the cache check, because this is the only credential-free
  // place the REAL prompt builder runs end to end — and because the WhatsApp
  // path builds this prompt on the service role, where RLS is bypassed by design
  // and this filter is the entire boundary.
  check(
    `manager/${locale}: a colleague's personal memory reaches NEITHER half`,
    !cached.includes('SEGREDO DO COLEGA') && !uncached.includes('SEGREDO DO COLEGA'),
  );

  const tokens = estTokens(cached);
  check(
    `manager/${locale}: cached prefix clears Sonnet 5's 1024-token floor (~${tokens} tok, ${cached.length} chars)`,
    tokens >= MIN_CACHEABLE_PREFIX_TOKENS['claude-sonnet-5'],
    `~${tokens} tokens`,
  );
}

// The onboarding checklist (migration 0046) is per-TENANT and rebuilt from the
// tenant's own counts on every turn, so it belongs strictly below the
// breakpoint — the same argument as the snapshot it is derived from. Above the
// line it would fragment the cached prefix per company AND rewrite it every
// time somebody added a worker, which during onboarding is every few messages.
{
  const fresh = stubDb({
    companies: { data: { name: 'Casa Nova Lda', onboarded_at: null, about: null }, error: null },
    profiles: { data: { full_name: 'Aníbal Gatsby' }, error: null },
    jobs: { count: 0, error: null, data: [] },
    workers: { count: 0, error: null, data: [] },
    tasks: { count: 0, error: null },
    proposals: { count: 0, error: null },
  });
  const msgs = await buildSystemPrompt({
    db: fresh,
    companyId: 'company-1',
    userId: 'profile-1',
    appUrl: 'https://www.construcapo.com',
    summary: null,
    locales: { user: 'pt-PT', company: 'pt-PT' },
  });
  const cached = msgs[0]?.content ?? '';
  const uncached = msgs[1]?.content ?? '';
  check(
    'the onboarding checklist appears when onboarded_at is null',
    uncached.includes('# Configuração inicial em curso'),
  );
  check(
    'and it stays BELOW the cache breakpoint',
    !cached.includes('# Configuração inicial em curso'),
  );
  check(
    'the cached half is still exactly persona ⊕ policy ⊕ language directive',
    cached === joinBlocks(managerStableBlocks({ user: 'pt-PT', company: 'pt-PT' })),
  );
  // The dashboard link is WITHHELD until finish_onboarding returns it, and this
  // is where that stops being a promise in the copy and becomes a property of
  // the prompt: the string is in NEITHER half while the setup is running. Left
  // in the snapshot from turn one, the model has it in front of it for the whole
  // conversation with nothing telling it to wait, and the plausible failure is
  // the original bug in a new shape: "meanwhile you can see everything at
  // construcapo.com", the manager leaves, the company is never finished.
  check(
    'the dashboard URL reaches NEITHER half while onboarded_at is null',
    !cached.includes('https://www.construcapo.com') && !uncached.includes('https://www.construcapo.com'),
  );
}

// Deploy ordering (0046 unapplied): the companies row simply has no
// `onboarded_at` key. That must degrade to the PRE-migration product, so no
// checklist, and the dashboard line comes back — an established tenant is
// exactly who it is for.
{
  const preMigration = stubDb({
    companies: { data: { name: 'Construções Silva' }, error: null },
    profiles: { data: { full_name: 'Aníbal Gatsby' }, error: null },
    jobs: { count: 3, error: null, data: [] },
    workers: { count: 7, error: null, data: [] },
    tasks: { count: 12, error: null },
    proposals: { count: 1, error: null },
  });
  const msgs = await buildSystemPrompt({
    db: preMigration,
    companyId: 'company-1',
    userId: 'profile-1',
    appUrl: 'https://www.construcapo.com',
    summary: null,
    locales: { user: 'pt-PT', company: 'pt-PT' },
  });
  const whole = `${msgs[0]?.content ?? ''}\n${msgs[1]?.content ?? ''}`;
  check(
    'an ABSENT onboarded_at column renders no checklist at all',
    !whole.includes('# Configuração inicial em curso'),
  );
  check(
    'and the tenant is treated as onboarded, so the dashboard line is present',
    whole.includes('https://www.construcapo.com'),
  );
}

// The two live-fact reads fail INDEPENDENTLY (issue #62). If a transient
// failure on the company counts also silenced the manager's name, the model
// would fall straight back to reading a name out of the frozen summary — the
// exact bug, reappearing only under a hiccup nobody would reproduce.
{
  const degraded = stubDb({
    companies: { data: null, error: { message: 'transient' } },
    profiles: { data: { full_name: 'Aníbal Gatsby' }, error: null },
  });
  const msgs = await buildSystemPrompt({
    db: degraded,
    companyId: 'company-1',
    userId: 'profile-1',
    appUrl: 'https://www.construcapo.com',
    summary: null,
    locales: { user: 'pt-PT', company: 'pt-PT' },
  });
  const uncached = msgs[1]?.content ?? '';
  check("manager: the name survives a failed company-snapshot read", uncached.includes('Aníbal Gatsby'));
  check('manager: and the counts are absent rather than reported as zero', !uncached.includes('Obras ativas'));
}

// The crew member's own identity (W4). Every field of it is per-WORKER, which
// is why the assertions below are about WHERE it lands rather than about how it
// reads: above the breakpoint it would write one cache entry per crew member
// and read none, which is exactly the trap loadManagerName had to avoid on the
// manager side (issue #62).
const IDENTITY: WorkerIdentity = {
  workerName: 'Miguel Sousa',
  trade: 'pintor',
  companyName: 'Construções Silva',
  managerNames: ['Aníbal Gatsby'],
};

const OTHER_IDENTITY: WorkerIdentity = {
  workerName: 'Zé Ferreira',
  trade: null,
  companyName: 'Construções Silva',
  managerNames: [],
};

for (const locale of LOCALES) {
  const msgs = await buildWorkerSystemPrompt({
    db,
    locale,
    today: '2026-08-14',
    tasks: [],
    pendingPhotos: [],
    identity: IDENTITY,
  });

  eq(`worker/${locale}: two system messages`, msgs.length, 2);
  eq(`worker/${locale}: breakpoint on the first`, msgs[0]?.providerOptions, CACHE_BREAKPOINT);
  eq(`worker/${locale}: none on the second`, msgs[1]?.providerOptions, undefined);

  const cached = msgs[0]?.content ?? '';
  const uncached = msgs[1]?.content ?? '';
  eq(
    `worker/${locale}: the cached half is exactly persona ⊕ policy ⊕ language directive`,
    cached,
    joinBlocks(workerStableBlocks(locale)),
  );
  check(
    `worker/${locale}: today's date and this crew member's tasks stay BELOW the breakpoint`,
    !cached.includes("Today's date") && uncached.includes('2026-08-14') && uncached.includes('Your tasks'),
  );
  const tokens = estTokens(cached);
  check(
    `worker/${locale}: cached prefix clears Sonnet 5's 1024-token floor (~${tokens} tok, ${cached.length} chars)`,
    tokens >= MIN_CACHEABLE_PREFIX_TOKENS['claude-sonnet-5'],
    `~${tokens} tokens`,
  );

  // ── the identity block (W4) ───────────────────────────────────────────────
  check(
    `worker/${locale}: the crew member's own name and company sit BELOW the breakpoint`,
    uncached.includes('Miguel Sousa') && uncached.includes('Construções Silva'),
  );
  check(
    `worker/${locale}: and their manager's name is below it too`,
    uncached.includes('Aníbal Gatsby'),
  );
  check(
    `worker/${locale}: nothing about this crew member reached the cached half`,
    !cached.includes('Miguel Sousa') &&
      !cached.includes('Construções Silva') &&
      !cached.includes('Aníbal Gatsby') &&
      !cached.includes('pintor'),
  );

  // THE ONE THAT MATTERS. Two crew members of the same company must share one
  // cache entry. If the identity ever migrates above the line, this fails and
  // the entry starts being rewritten once per person per message.
  const other = await buildWorkerSystemPrompt({
    db,
    locale,
    today: '2026-08-14',
    tasks: [],
    pendingPhotos: [],
    identity: OTHER_IDENTITY,
  });
  eq(`worker/${locale}: the cached half is IDENTICAL for a different crew member`, other[0]?.content, cached);
  check(
    `worker/${locale}: while the uncached half follows the person`,
    (other[1]?.content ?? '').includes('Zé Ferreira'),
  );

  // A failed identity read drops the block and nothing else. Same posture as a
  // failed company-snapshot read on the manager side: the turn survives.
  const anonymous = await buildWorkerSystemPrompt({
    db,
    locale,
    today: '2026-08-14',
    tasks: [],
    pendingPhotos: [],
    identity: null,
  });
  eq(`worker/${locale}: a failed identity read leaves the cached half untouched`, anonymous[0]?.content, cached);
  check(
    `worker/${locale}: and drops the block rather than the turn`,
    !(anonymous[1]?.content ?? '').includes('Miguel Sousa') && (anonymous[1]?.content ?? '').includes('2026-08-14'),
  );
}

// ── 3. the tool breakpoint lands on the LAST tool and nowhere else ──────────
{
  const managerTools = toAiTools({} as ToolContext);
  const workerTools = toWorkerAiTools({} as WorkerContext);

  for (const [label, tools] of [
    ['manager roster', managerTools],
    ['worker roster', workerTools],
  ] as const) {
    const names = Object.keys(tools);
    const marked = withToolCacheBreakpoint(tools);
    const withBreakpoint = Object.keys(marked).filter(n => marked[n]?.providerOptions !== undefined);

    check(`${label}: is non-empty (${names.length} tools)`, names.length > 0);
    eq(`${label}: exactly one tool carries a breakpoint`, withBreakpoint.length, 1);
    eq(`${label}: and it is the LAST one`, withBreakpoint[0], names[names.length - 1]);
    eq(`${label}: breakpoint value is the shared constant`, marked[names[names.length - 1]!]?.providerOptions, CACHE_BREAKPOINT);
    eq(`${label}: key order is preserved`, Object.keys(marked).join(','), names.join(','));
    // The spread must carry `execute` across. Losing it would not error — the
    // marked tool would simply stop doing anything, which for the manager
    // roster is whichever capability happens to be last in the array.
    const lastName = names[names.length - 1]!;
    check(
      `${label}: the marked tool keeps its description, schema AND execute`,
      marked[lastName]?.description === tools[lastName]?.description &&
        marked[lastName]?.inputSchema === tools[lastName]?.inputSchema &&
        typeof (marked[lastName] as { execute?: unknown } | undefined)?.execute === 'function' &&
        (marked[lastName] as { execute?: unknown }).execute ===
          (tools[lastName] as { execute?: unknown }).execute,
    );
    check(
      `${label}: earlier tools are passed through untouched`,
      names.slice(0, -1).every(n => marked[n] === tools[n]),
    );
    check(
      `${label}: the input ToolSet is not mutated`,
      names.every(n => tools[n]?.providerOptions === undefined),
    );
  }

  eq('an empty ToolSet is returned unchanged', Object.keys(withToolCacheBreakpoint({})).length, 0);

  // Two breakpoints per agent turn — tools, then the stable system half.
  // Anthropic drops the fifth with a warning nobody reads, so keep counting.
  const perTurn = 2;
  check(`a turn spends ${perTurn} of Anthropic's ${MAX_CACHE_BREAKPOINTS} breakpoints`, perTurn <= MAX_CACHE_BREAKPOINTS);
}

// ── 4. per-role caching decisions ───────────────────────────────────────────
{
  for (const [role, id] of Object.entries(MODEL_IDS)) {
    // getModel() constructs the provider model; it must not need a key to do so.
    const built = getModel(role as keyof typeof MODEL_IDS) as { modelId?: string };
    eq(`MODEL_IDS.${role} matches what getModel actually builds`, built.modelId, id);
  }

  eq('exactly one role is cached', CACHED_ROLES.length, 1);
  eq('and it is the conversation role (both agent loops)', CACHED_ROLES[0], 'conversation');
  eq(
    'the cached role runs on a model whose floor we know',
    MIN_CACHEABLE_PREFIX_TOKENS[MODEL_IDS.conversation],
    1024,
  );

  // The trap the per-role table exists to record: these three roles are on
  // Haiku 4.5, whose floor is FOUR TIMES Sonnet 5's. Their system prompts are
  // a few hundred tokens, so a breakpoint on any of them would be a silent
  // no-op that still bills the 1.25× write. If a future change moves one of
  // these to a Sonnet-tier model, this assertion fires and the decision gets
  // re-made deliberately.
  for (const role of ['summarizer', 'extraction', 'translation'] as const) {
    check(`${role} is deliberately UNCACHED`, !CACHED_ROLES.includes(role));
    eq(`${role} sits behind Haiku 4.5's 4096-token floor`, MIN_CACHEABLE_PREFIX_TOKENS[MODEL_IDS[role]], 4096);
  }
  check('planner is deliberately UNCACHED (one call per plan, prompt under the floor)', !CACHED_ROLES.includes('planner'));
  check('transcription is not an Anthropic model at all', !(MODEL_IDS.transcription in MIN_CACHEABLE_PREFIX_TOKENS));
}

// ── 5. end to end: what the provider would actually POST ────────────────────
//
// The only assertion here that a refactor cannot fool. Everything above tests
// our own helpers; this drives the real @ai-sdk/anthropic provider through
// `generateText` with a stubbed global fetch and reads the request body.
{
  const { generateText } = await import('ai');

  let body: {
    system?: { type: string; text: string; cache_control?: unknown }[];
    tools?: { name: string; cache_control?: unknown }[];
    messages?: unknown[];
  } | null = null;

  const realFetch = globalThis.fetch;
  const realKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'cache-check-not-a-real-key';
  globalThis.fetch = (async (_input: unknown, init?: { body?: string }) => {
    body = JSON.parse(init?.body ?? '{}');
    return new Response(
      JSON.stringify({
        id: 'msg_cache_check',
        type: 'message',
        role: 'assistant',
        model: MODEL_IDS.conversation,
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof globalThis.fetch;

  try {
    const locales: LocaleContext = { user: 'pt-PT', company: 'pt-PT' };
    await generateText({
      model: getModel('conversation'),
      instructions: await buildSystemPrompt({
        db,
        companyId: 'company-1',
        userId: 'profile-1',
        appUrl: 'https://www.construcapo.com',
        summary: null,
        locales,
      }),
      tools: withToolCacheBreakpoint(toAiTools({} as ToolContext)),
      messages: [{ role: 'user', content: 'olá' }],
    });
  } catch (e) {
    check('generateText reached the provider', false, e instanceof Error ? e.message : String(e));
  } finally {
    globalThis.fetch = realFetch;
    if (realKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = realKey;
  }

  const sent = body as NonNullable<typeof body> | null;
  check('a request body was captured', sent !== null);

  if (sent) {
    const system = sent.system ?? [];
    const tools = sent.tools ?? [];

    eq('wire: the system prompt is two text blocks, not one', system.length, 2);
    eq('wire: cache_control on the FIRST system block', JSON.stringify(system[0]?.cache_control), '{"type":"ephemeral"}');
    eq('wire: none on the second', system[1]?.cache_control, undefined);
    check(
      'wire: the dated half is the uncached one',
      !(system[0]?.text ?? '').includes("Today's date") && (system[1]?.text ?? '').includes("Today's date"),
    );

    check('wire: tools were sent', tools.length > 0);
    const cachedTools = tools.filter(t => t.cache_control !== undefined);
    eq('wire: exactly one tool definition carries cache_control', cachedTools.length, 1);
    eq('wire: and it is the last tool sent', cachedTools[0]?.name, tools[tools.length - 1]?.name);
    eq(
      'wire: its TTL is the 5-minute default (no ttl field)',
      JSON.stringify(cachedTools[0]?.cache_control),
      '{"type":"ephemeral"}',
    );

    // Render order is tools → system → messages, so the tool breakpoint is the
    // EARLIER cut and the system one covers it. Two entries, one prefix.
    eq(
      'wire: the whole request spends exactly two breakpoints',
      cachedTools.length + system.filter(s => s.cache_control !== undefined).length,
      2,
    );
    check(
      'wire: no cache_control leaked onto the user turn',
      JSON.stringify(sent.messages ?? []).includes('cache_control') === false,
    );
  }
}

// ── the memory ceiling (issue #48) ──────────────────────────────────────────
//
// The memory block lives in the UN-cached half, so it never invalidates a cached
// prefix — but it is re-sent at FULL PRICE on every one of the up-to-twelve
// requests a single manager message costs, and since #48 it grows on a nightly
// schedule with nobody watching. The cap is the only thing bounding that, and
// this is the credential-free place to pin it.
{
  const row = (i: number, profileId: string | null = null, content = `memory ${i}`) => ({
    kind: 'fact',
    content,
    // Ascending timestamps, so `${i}` is also the recency order. Milliseconds
    // rather than seconds, zero-padded to three digits: these are compared as
    // STRINGS (they come out of Postgres as ISO text), and a two-digit seconds
    // field silently stops being monotonic past 59.
    created_at: `2026-01-01T00:00:00.${String(i).padStart(3, '0')}Z`,
    profile_id: profileId,
  });

  // ── visibility ───────────────────────────────────────────────────────────
  check('a company memory (null owner) is visible to everyone', memoryVisibleTo(row(1), 'profile-1'));
  check(
    'an ABSENT profile_id reads as company-wide',
    memoryVisibleTo({ kind: 'fact', content: 'x', created_at: '2026-01-01T00:00:00Z' }, 'profile-1'),
    'a deploy landing before 0037 must degrade, never hide every memory',
  );
  check('my own memory is visible to me', memoryVisibleTo(row(1, 'profile-1'), 'profile-1'));
  check("a colleague's memory is NOT visible to me", !memoryVisibleTo(row(1, 'profile-2'), 'profile-1'));
  check(
    "a colleague's memory is not visible to a NULL reader either",
    !memoryVisibleTo(row(1, 'profile-2'), null),
    'the nightly pass reads with profileId=null and must see company memories only',
  );

  // ── the row cap ──────────────────────────────────────────────────────────
  {
    const many = Array.from({ length: MEMORY_PROMPT_ROWS * 3 }, (_, i) => row(i));
    const { carried, dropped } = selectPromptMemories(many, 'profile-1');
    eq('the row cap binds at MEMORY_PROMPT_ROWS', carried.length, MEMORY_PROMPT_ROWS);
    eq('and everything else is reported dropped', dropped, MEMORY_PROMPT_ROWS * 2);
    // NEWEST kept, OLDEST dropped: a memory written last night is likelier to be
    // true than one written in March.
    check(
      'the NEWEST rows are the ones carried',
      carried.every(r => Number(r.content.split(' ')[1]) >= MEMORY_PROMPT_ROWS * 2),
      carried[0]?.content,
    );
    // …and rendered oldest-first, which is the order buildSystemPrompt has
    // always produced.
    check(
      'the carried rows are rendered chronologically',
      carried.every((r, i) => i === 0 || carried[i - 1].created_at <= r.created_at),
    );
  }

  // ── the character cap ────────────────────────────────────────────────────
  {
    // Ten rows well under the row cap but far over the character budget.
    const long = Array.from({ length: 10 }, (_, i) => row(i, null, 'x'.repeat(1000)));
    const { carried } = selectPromptMemories(long, 'profile-1');
    const chars = carried.reduce((n, r) => n + r.content.length + 1, 0);
    check('the character cap binds before the row cap when rows are long', carried.length < 10, `${carried.length} rows`);
    check(`and the carried block stays within ${MEMORY_PROMPT_MAX_CHARS} chars`, chars <= MEMORY_PROMPT_MAX_CHARS, `${chars} chars`);
  }

  // ── one enormous row ─────────────────────────────────────────────────────
  // A single row over the whole budget must still be carried. Returning NOTHING
  // would mean one bad row silently erasing all memory — and 0037's CHECK caps a
  // row at 240 chars anyway, so this can only arise from pre-0037 history.
  {
    const { carried } = selectPromptMemories([row(1, null, 'y'.repeat(MEMORY_PROMPT_MAX_CHARS * 2))], 'profile-1');
    eq('one over-budget row is still carried rather than erasing memory', carried.length, 1);
  }

  eq('no visible memories carries nothing', selectPromptMemories([], 'profile-1').carried.length, 0);
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(lines.join('\n'));
console.log(`\nCache check: ${lines.length - failures}/${lines.length} passed; failures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
