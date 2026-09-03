// Onboarding check — the deterministic half of "Capo stopped setting me up".
//
// A fresh manager was greeted, asked for a client name, given one obra, told
// "done", and left with an empty company. Nothing errored. The onboarding
// instructions were DERIVED from row counts, and the derivation switched itself
// off the moment one job and one worker existed: there was no "no tasks yet"
// case at all, nothing asked what the business does, and no step handed over the
// dashboard. Migration 0046 replaces that inference with a recorded fact
// (`companies.onboarded_at`) and a checklist rebuilt on every turn.
//
// Every regression this file guards is SILENT in production. A checklist that
// stops rendering does not throw: the conversation simply ends early and looks
// polite doing it. A checklist that keeps rendering after the setup is finished
// does not throw either: an established manager is just told, forever, that his
// company is about to be configured. Neither shows up in `tsc`, ESLint or a
// build, and neither leaves a log line.
//
// So this asserts the three things that decide the behaviour:
//
//   1. THE COLUMN DECIDES, NOT THE COUNTS. `onboarded_at` null means the
//      checklist runs whatever the rows say; set means it never runs again,
//      whatever the rows say. That is the whole point of the column.
//   2. EVERY STATE RENDERS SOMETHING TRUE. Fresh, part-done, and complete but
//      unstamped each produce a block, in all three languages, naming exactly
//      the items that are missing — and the complete-but-unstamped one still
//      tells Capo to call finish_onboarding, because that is the state in which
//      the conversation ends without a stamp otherwise.
//   3. THE TOOL AND THE PROMPT AGREE. `finish_onboarding` re-reads the same
//      snapshot through the same rule, so it cannot stamp a company the block
//      still shows as unfinished, and cannot refuse one the block calls done.
//
// Credential-free, no network, no model call, so it runs in CI on every PR.
// Run with `pnpm onboarding-check`. Exit 0 = green, 1 = at least one failure.

import type { Db } from '@capo/db/client';
import type { Locale } from '@capo/i18n/locale';
import {
  buildOnboardingBlock,
  missingOnboardingItems,
  type CompanySnapshot,
} from '@capo/core/agent/context';
import { roster } from '@capo/core/capabilities';
import type { CapoTool, ToolContext } from '@capo/core/capabilities/types';

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

/** The heading each locale's checklist block opens with. */
const CHECKLIST_HEADING: Record<Locale, string> = {
  'pt-PT': '# Configuração inicial em curso',
  'es-ES': '# Configuración inicial en marcha',
  'en-US': '# Initial setup in progress',
};

/** The nudge block that a FINISHED tenant with a gap still gets, unchanged. */
const NUDGE_HEADING: Record<Locale, string> = {
  'pt-PT': '# Configuração incompleta',
  'es-ES': '# Configuración incompleta',
  'en-US': '# Incomplete setup',
};

const EMPTY: CompanySnapshot = {
  companyName: 'Casa Nova Lda',
  activeObras: 0,
  activeWorkers: 0,
  openTasks: 0,
  pendingProposals: 0,
  onboardedAt: null,
  about: null,
  jobsWithClient: 0,
  jobsWithAddress: 0,
  workersWithPhone: 0,
  workersWithConsent: 0,
};

const snap = (over: Partial<CompanySnapshot>): CompanySnapshot => ({ ...EMPTY, ...over });

// ── 1. the rule ─────────────────────────────────────────────────────────────
{
  eq('a brand new company is missing all four items', missingOnboardingItems(EMPTY).join(','), 'about,jobs,crew,tasks');
  eq(
    'the order is the order to ask in: what the business does comes first',
    missingOnboardingItems(EMPTY)[0],
    'about',
  );
  eq(
    'a description alone leaves three',
    missingOnboardingItems(snap({ about: 'Remodelações e pinturas' })).join(','),
    'jobs,crew,tasks',
  );
  check(
    'whitespace is not a description',
    missingOnboardingItems(snap({ about: '   ' })).includes('about'),
  );
  eq(
    'THE BUG: one obra and one worker is NOT a finished setup',
    missingOnboardingItems(snap({ about: 'Pinturas', activeObras: 1, activeWorkers: 1 })).join(','),
    'tasks',
    // Before 0046 this exact state turned the whole onboarding block off, which
    // is what let Capo say "done" over an empty task board.
  );
  eq(
    'all four present leaves nothing',
    missingOnboardingItems(snap({ about: 'Pinturas', activeObras: 1, activeWorkers: 2, openTasks: 3 })).length,
    0,
  );
  check(
    'the rule ignores onboarded_at entirely',
    missingOnboardingItems(snap({ onboardedAt: '2026-01-01T00:00:00Z' })).length === 4,
    'the stamp is a decision, the rule is about the rows',
  );
}

// ── 2. the block, per state, per language ───────────────────────────────────
for (const locale of LOCALES) {
  const heading = CHECKLIST_HEADING[locale];

  // fresh
  {
    const block = buildOnboardingBlock(EMPTY, locale) ?? '';
    check(`${locale}/fresh: renders the checklist`, block.startsWith(heading), block.slice(0, 40));
    check(`${locale}/fresh: names finish_onboarding as the end of the road`, block.includes('finish_onboarding'));
    check(`${locale}/fresh: names set_company_about`, block.includes('set_company_about'));
    check(`${locale}/fresh: names add_worker`, block.includes('add_worker'));
    check(
      `${locale}/fresh: does NOT tell Capo to finish now`,
      !block.includes('finish_onboarding AGORA') &&
        !block.includes('finish_onboarding AHORA') &&
        !block.includes('finish_onboarding NOW'),
    );
  }

  // about only
  {
    const block = buildOnboardingBlock(snap({ about: 'Remodelações' }), locale) ?? '';
    check(`${locale}/about-only: still the checklist`, block.startsWith(heading));
    check(`${locale}/about-only: quotes what the manager said`, block.includes('Remodelações'));
  }

  // obra only
  {
    const block =
      buildOnboardingBlock(snap({ activeObras: 1, jobsWithClient: 1, jobsWithAddress: 0 }), locale) ?? '';
    check(`${locale}/obra-only: still the checklist`, block.startsWith(heading));
    check(
      `${locale}/obra-only: the obra tally is shown, so the missing address can be asked for`,
      block.includes('1'),
    );
  }

  // everything but tasks — the state that used to end the conversation
  {
    const block =
      buildOnboardingBlock(
        snap({ about: 'Pinturas', activeObras: 1, jobsWithClient: 1, jobsWithAddress: 1, activeWorkers: 2, workersWithPhone: 2, workersWithConsent: 1 }),
        locale,
      ) ?? '';
    check(`${locale}/no-tasks: the checklist is STILL on`, block.startsWith(heading));
    check(
      `${locale}/no-tasks: and it does not claim the list is complete`,
      !block.includes('finish_onboarding AGORA') &&
        !block.includes('finish_onboarding AHORA') &&
        !block.includes('finish_onboarding NOW'),
    );
  }

  // complete but unstamped: the one state where the block must push the stamp
  {
    const block =
      buildOnboardingBlock(
        snap({ about: 'Pinturas', activeObras: 1, jobsWithClient: 1, jobsWithAddress: 1, activeWorkers: 2, workersWithPhone: 2, workersWithConsent: 2, openTasks: 4 }),
        locale,
      ) ?? '';
    check(`${locale}/complete-unstamped: the block is still rendered`, block.startsWith(heading));
    check(
      `${locale}/complete-unstamped: and it tells Capo to call finish_onboarding NOW`,
      block.includes('finish_onboarding AGORA') ||
        block.includes('finish_onboarding AHORA') ||
        block.includes('finish_onboarding NOW'),
    );
  }

  // stamped: never again, whatever the counts say
  {
    const done = snap({
      onboardedAt: '2026-01-01T00:00:00Z',
      about: 'Pinturas',
      activeObras: 2,
      activeWorkers: 3,
      openTasks: 5,
    });
    eq(`${locale}/stamped: a healthy tenant gets no block at all`, buildOnboardingBlock(done, locale), null);

    // A live tenant between jobs. The pre-0046 nudge, unchanged: this is the
    // case that must never restart an onboarding conversation.
    const between = { ...done, activeObras: 0 };
    const block = buildOnboardingBlock(between, locale) ?? '';
    check(`${locale}/stamped: an empty obra list is the soft nudge, not the checklist`, block.startsWith(NUDGE_HEADING[locale]));
    check(`${locale}/stamped: and never the checklist`, !block.includes(heading));
  }
}

// ── 3. the tools ────────────────────────────────────────────────────────────
{
  const setAbout = roster.find(t => t.name === 'set_company_about');
  const finish = roster.find(t => t.name === 'finish_onboarding');

  check('set_company_about is in the manager roster', setAbout !== undefined);
  check('finish_onboarding is in the manager roster', finish !== undefined);
  // Guarding either would meet a brand new manager with an approval card asking
  // him to confirm the sentence he had just typed, under the product default
  // posture (always_ask, 0031). Neither changes the business.
  check('set_company_about is UNGUARDED', setAbout?.guarded !== true);
  check('finish_onboarding is UNGUARDED', finish?.guarded !== true);

  const parsed = setAbout?.inputSchema.safeParse({ about: 'x'.repeat(601) });
  check('set_company_about refuses a description over the 600-char column limit', parsed?.success === false);
  check(
    'and accepts an ordinary one',
    setAbout?.inputSchema.safeParse({ about: 'Remodelações de interiores em Lisboa.' }).success === true,
  );

  // finish_onboarding re-reads rather than trusting the checklist that was
  // rendered at the top of the turn: the turn itself may have created the last
  // task. These two cases pin that the re-read is the authority.
  const ctxWith = (company: Record<string, unknown>, counts: Record<string, number>): ToolContext => {
    const stub = (table: string): unknown =>
      new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === 'then') {
              return (resolve: (v: unknown) => void) =>
                resolve(
                  table === 'companies'
                    ? { data: company, error: null }
                    : { data: [], error: null, count: counts[table] ?? 0 },
                );
            }
            return () => stub(table);
          },
        },
      );
    return {
      companyId: 'company-1',
      conversationId: 'conversation-1',
      db: { from: (table: string) => stub(table), rpc: async () => ({ data: null, error: null }) } as unknown as Db,
      actor: 'manager',
      recentUserTexts: [],
      userId: 'profile-1',
      confirmPosture: 'always_ask',
      appUrl: 'https://www.construcapo.com',
      locales: { user: 'pt-PT', company: 'pt-PT' },
    };
  };

  const notReady = (await (finish as CapoTool).execute(
    {},
    ctxWith({ name: 'Casa Nova Lda', onboarded_at: null, about: null }, { jobs: 0, workers: 0, tasks: 0 }),
  )) as { status: string; missing?: string[] };
  eq('finish_onboarding refuses a company that is not set up', notReady.status, 'not_ready');
  eq('and says what is missing', notReady.missing?.join(','), 'about,jobs,crew,tasks');

  const already = (await (finish as CapoTool).execute(
    {},
    ctxWith(
      { name: 'Casa Nova Lda', onboarded_at: '2026-01-01T00:00:00Z', about: 'Pinturas' },
      { jobs: 1, workers: 1, tasks: 1 },
    ),
  )) as { status: string; dashboard_url?: string };
  eq('an already-finished company is not an error', already.status, 'already_finished');
  eq('and still hands back the dashboard link', already.dashboard_url, 'https://www.construcapo.com');
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(lines.join('\n'));
console.log(`\nOnboarding check: ${lines.length - failures}/${lines.length} passed; failures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
