// Migration drift — does the LIVE database carry every migration this repo has
// written?
//
// ── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// On 2026-08-30 Federico paused an obra and it vanished from the Obras screen.
// The fix for exactly that (#95 → PR #98 → 0038_dashboard_obras_paused.sql) had
// been merged to main three weeks earlier and the APP half of it was live. The
// DATABASE half had never been applied: production stopped at 0037, and
// dashboard_obras was still 0005's `where j.status = 'active'`.
//
// Nothing was broken and nothing raised an error. The app was perfectly
// prepared to render a paused obra; it was simply never handed one. That is the
// signature of this whole failure class — a merged migration that never ran
// presents as a FEATURE THAT SILENTLY DIDN'T SHIP, never as a crash.
//
// This is the second time it has happened here. AGENTS.md already names it
// ("a migration has been skipped in production while a later one was applied"),
// and welcome_ledger_ready() exists as a hand-built deploy gate for one route
// because of it. That approach does not generalise: it is a bespoke marker per
// feature, written by whoever remembered to. This file asks the general
// question once.
//
// ── WHAT IT PROVES, AND WHAT IT DOES NOT ────────────────────────────────────
// PROVES: every .sql file in supabase/migrations has an entry in the project's
// applied-migration history, and every entry has a file.
//
// DOES NOT PROVE: anything about the ORDER they were applied in — see the note
// on the set comparison below, which is a fact about this project's real
// history rather than a shortcut.
//
// DOES NOT PROVE: that the applied migration did what the file says. A
// migration edited AFTER being applied still reads as applied — which is why
// the repo's rule that a migration is never edited afterwards is load-bearing,
// and why this check is not a substitute for it. It also says nothing about
// schema changes made by hand in the dashboard, which leave no file to compare.
//
// ── WHY IT IS NOT IN CI ─────────────────────────────────────────────────────
// It needs credentials for a live project, so it sits with `pnpm rls-matrix`
// and `pnpm agent-smoke` outside the per-PR gate. Run it AFTER a deploy that
// carries a migration:  merge → deploy → apply migrations → pnpm migration-check
//
// ── WHY THE MANAGEMENT API AND NOT A QUERY ──────────────────────────────────
// The history lives in `supabase_migrations.schema_migrations`, a schema
// PostgREST does not expose — so the service-role client every other script in
// this folder uses cannot read it, and the alternatives are worse. Widening the
// exposed schemas, or adding a SECURITY DEFINER reader in `public`, would both
// buy this check a permanent new piece of attack surface on the tenant-facing
// API. A read-only Management API call buys none.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ── env ─────────────────────────────────────────────────────────────────────
// Same loader as scripts/rls-isolation-matrix.mjs: real process env wins, and
// apps/web/.env.local fills the gaps. A missing file is not fatal here — a
// SUPABASE_ACCESS_TOKEN exported in the shell is the likelier setup, since it
// is a personal token rather than a project secret and does not belong in an
// app's env file.
const env: Record<string, string | undefined> = { ...process.env };
try {
  const envFile = path.join(repoRoot, 'apps/web/.env.local');
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !(m[1] in process.env)) env[m[1]!] = m[2]!.replace(/^["']|["']$/g, '');
  }
} catch {
  // no .env.local (a fresh clone, or CI) — fall through to the checks below
}

const accessToken = env.SUPABASE_ACCESS_TOKEN;
// The project ref is the subdomain of the project URL, so nothing new has to be
// configured: whichever project this checkout is pointed at is the one checked.
const projectUrl = env.SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL;
const ref = env.SUPABASE_PROJECT_REF ?? projectUrl?.match(/^https:\/\/([a-z0-9]+)\.supabase\./)?.[1];

if (!accessToken || !ref) {
  console.error('Cannot check migration drift — missing configuration.\n');
  if (!accessToken) {
    console.error(
      '  SUPABASE_ACCESS_TOKEN is not set. This is a personal access token, not a\n' +
        '  project key: create one at https://supabase.com/dashboard/account/tokens\n' +
        '  and export it in your shell. It is the same kind of token the Supabase\n' +
        '  CLI and MCP server use.',
    );
  }
  if (!ref) {
    console.error(
      '  Could not work out the project ref. Set SUPABASE_URL (or\n' +
        '  NEXT_PUBLIC_SUPABASE_URL) in apps/web/.env.local, or set\n' +
        '  SUPABASE_PROJECT_REF directly.',
    );
  }
  process.exit(2);
}

// ── the files on disk ───────────────────────────────────────────────────────
// `0038_dashboard_obras_paused.sql` → { file: '0038_…sql', slug: 'dashboard_obras_paused' }
type LocalMigration = { file: string; slug: string };

const migrationsDir = path.join(repoRoot, 'supabase/migrations');
const local: LocalMigration[] = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((file) => {
    const m = file.match(/^(\d+)_(.+)\.sql$/);
    if (!m) {
      console.error(`Migration file does not match NNNN_slug.sql: ${file}`);
      process.exit(2);
    }
    return { file, slug: m[2]! };
  });

// The repo numbers migrations 0001, 0002, … and the database records the
// timestamp and slug it was applied under (20260814145433 / memory_scope). The
// SLUG is therefore the only thing the two lists share, and it is what they are
// joined on.
//
// Deliberately a SET comparison and not a positional one, which is what the
// first draft of this file did until it was run against the real history: the
// applied ORDER does not match the repo's numbering, and never has. 0017
// (worker_checkins) was applied at 20260808140249, AFTER 0018/0019/0020, the
// three task_reviews migrations. Two streams of work landed the same day.
// Nothing is wrong with that — migrations here are independent files, not a
// replayed log — so a check that called it drift would cry wolf on a healthy
// database from its very first run, and be switched off.
//
// One row was applied under a different slug than its filename, back at the
// very start of the project. It is pinned here by name rather than by relaxing
// the comparison for everything: an unexplained mismatch is exactly the signal
// this file exists to raise.
const SLUG_ALIASES: Record<string, string> = {
  init: 'init_capo_foundation', // 0001_init.sql
};

// ── the history in the live project ─────────────────────────────────────────
type AppliedMigration = { version: string; name?: string | null };

const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/migrations`, {
  headers: { Authorization: `Bearer ${accessToken}` },
});

if (!res.ok) {
  console.error(`Management API refused the request: ${res.status} ${res.statusText}`);
  if (res.status === 401 || res.status === 403) {
    console.error('Check that SUPABASE_ACCESS_TOKEN is current and can read this project.');
  }
  console.error(await res.text().catch(() => ''));
  process.exit(2);
}

const payload: unknown = await res.json();
const rows: AppliedMigration[] = Array.isArray(payload)
  ? (payload as AppliedMigration[])
  : ((payload as { migrations?: AppliedMigration[] }).migrations ?? []);

// The API returns them in application order, but sorting on the version makes
// that an assumption this file does not have to make.
const applied = [...rows].sort((a, b) => String(a.version).localeCompare(String(b.version)));

// ── compare ─────────────────────────────────────────────────────────────────
const appliedBySlug = new Map<string, AppliedMigration>();
for (const row of applied) if (row.name) appliedBySlug.set(row.name, row);

const problems: string[] = [];
const claimed = new Set<string>();
const seenSlugs = new Set<string>();

for (const file of local) {
  const expected = SLUG_ALIASES[file.slug] ?? file.slug;

  // Two files sharing a slug would make the set comparison lie — the second
  // would be "found" by the first one's row. Cheap to rule out, so rule it out.
  if (seenSlugs.has(expected)) {
    problems.push(`DUPLICATE     ${file.file} reuses the slug "${expected}"`);
    continue;
  }
  seenSlugs.add(expected);

  const row = appliedBySlug.get(expected);
  if (!row) {
    problems.push(`NOT APPLIED   ${file.file}`);
    continue;
  }
  claimed.add(expected);
}

for (const row of applied) {
  const name = row.name ?? '';
  if (!claimed.has(name)) {
    problems.push(
      `NO FILE       ${row.version} "${name}" is applied but has no migration file`,
    );
  }
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(`Project:  ${ref}`);
console.log(`Repo:     ${local.length} migration files`);
console.log(`Database: ${applied.length} applied\n`);

if (problems.length === 0) {
  console.log(`Migration check: no drift — all ${local.length} migrations are applied.`);
  process.exit(0);
}

console.log(problems.join('\n'));
console.log(
  `\nMigration check: ${problems.length} problem${problems.length === 1 ? '' : 's'}.\n` +
    'A migration written but never applied means the app code shipped and the\n' +
    'database change did not — which shows up as a feature quietly not working,\n' +
    'never as an error. Apply the missing migrations before trusting the app.',
);
process.exit(1);
