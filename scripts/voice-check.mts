// Voice check — the static half of "Capo does not write like a machine".
//
// Like `pnpm scheduler-check` and unlike `pnpm agent-smoke`, it needs NO
// credentials, no network and no model, so it runs in CI on every PR.
//
// It exists because of one finding. Capo was not disobeying its instructions
// about tone; it was IMITATING them. The orchestration policy alone carried
// forty em dashes, the worker policy fourteen, the planner seventeen. A model
// copies the prose of the document that tells it how to write, so the loudest
// machine tell in the product was coming from the file that was supposed to
// prevent it. That is the general lesson, written down as a gate: a rule the
// prompt states and the prompt breaks is worse than no rule at all.
//
// Two kinds of file are scanned, for two different reasons:
//
//   MODEL-FACING (personas, policies, prompt blocks). A dash here becomes a
//   dash in every reply, in every language, for every tenant. Budget: zero,
//   permanently. These files were swept when the gate was written.
//
//   USER-FACING (the copy catalogs, the approval-card wording). Nobody reads
//   these out of a model; they are ours, and a copy file can be edited into a
//   violation exactly as easily as a model can produce one. About 190 dashes
//   were already there when this was written and are NOT swept, by an explicit
//   decision: they are frozen and drained instead.
//
// ── Why the budget is a NUMBER and not a file list ─────────────────────────
//
// scripts/design-check.mts solves the same problem with UNCONVERTED, a list of
// whole files that are exempt. That works there because those files are being
// converted wholesale and will leave the list entire.
//
// It would not work here. The copy catalogs go on receiving new copy for as
// long as the product is alive, so a file-level exemption would mean every
// sentence added to a dictionary for the next two years is ungated — which is
// precisely the thing this gate exists to stop. A per-file COUNT ratchets
// instead: a new violation pushes the file over its budget and fails, and a
// budget nobody lowered after a cleanup fails as STALE. It can only ever go
// down, and it tells you the number to write when it does.
//
// ── What it does NOT scan, and why that is a decision ──────────────────────
//
// Tool descriptions in packages/core/src/capabilities/*.ts are model-facing too
// and carry plenty of dashes across some thirty files. Including them now would
// make the budget table so long it would stop reading as a to-do list. Named
// here so widening the scan is somebody's decision rather than an oversight.
//
// Run with `pnpm voice-check`. Exit 0 = green, 1 = at least one failure.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DASHES = /[‒–—―]/g;

const MODEL_FACING = [
  'packages/core/src/agent/prompts',
  'packages/core/src/agent/persona',
  'packages/core/src/i18n',
];

const USER_FACING = ['packages/i18n/src/dictionaries', 'packages/core/src/capabilities/cards'];

/**
 * Per-file ceiling on long dashes in STRING LITERALS. May only ever shrink.
 *
 * A file absent from this table must have zero. Model-facing files are
 * deliberately absent: their budget is zero and is not negotiable, because a
 * dash there is a dash in every reply Capo writes.
 */
const BUDGET: Record<string, number> = {
  // Seeded from the state of the tree the day this gate was written, and never
  // to be raised. Every one of these is a sentence a manager or a crew member
  // actually reads: in the app, on an approval card, or in the 07:00 WhatsApp
  // message. Draining them is ordinary copy work that can happen a screen at a
  // time; what this table stops is the count going back UP while nobody is
  // looking.
  'packages/i18n/src/dictionaries/pt-PT.ts': 62,
  'packages/i18n/src/dictionaries/es-ES.ts': 60,
  'packages/i18n/src/dictionaries/en-US.ts': 62,
};

/**
 * Strip WHOLE-LINE comments before counting.
 *
 * Copied from design-check's codeOnly() and load-bearing for the identical
 * reason: the comments in these files are the reasoning the repository runs on,
 * an explanation of why a dash was wrong necessarily contains one, and the only
 * way to pass the gate otherwise would be to delete the explanation. That is a
 * trade this repo has already refused once.
 *
 * Whole-line only, never trailing: a `//` inside a string literal is a URL far
 * more often than it is a comment, and mistaking one for the other would hide
 * real copy from the scan.
 */
function stringsOnly(body: string): string {
  return body
    .split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter(f => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .map(f => join(dir, f))
    .sort();
}

let failures = 0;
let scanned = 0;
const suggestions: string[] = [];

function fail(message: string): void {
  failures += 1;
  console.error(`  FAIL  ${message}`);
}

function scan(dir: string, modelFacing: boolean): void {
  for (const file of tsFiles(dir)) {
    scanned += 1;
    const body = stringsOnly(readFileSync(file, 'utf8'));
    const found = (body.match(DASHES) ?? []).length;
    const budget = BUDGET[file] ?? 0;

    if (found > budget) {
      const where = modelFacing
        ? ' This is model-facing: a long dash here becomes one in every reply Capo writes, so the budget is zero and stays zero.'
        : '';
      fail(`${file}: ${found} long dash(es) in string literals, budget ${budget}.${where}`);
      if (!modelFacing && budget > 0) suggestions.push(`  '${file}': ${found},`);
      continue;
    }

    if (found < budget) {
      fail(`${file}: budget is STALE. It allows ${budget} long dash(es) and the file now has ${found}.`);
      suggestions.push(found === 0 ? `  (remove '${file}' from BUDGET)` : `  '${file}': ${found},`);
    }
  }
}

console.log('Voice check\n');
console.log('model-facing (budget: zero, always)');
for (const dir of MODEL_FACING) scan(dir, true);
console.log('user-facing (budget: ratcheting down)');
for (const dir of USER_FACING) scan(dir, false);

if (scanned === 0) {
  fail('scanned no files at all. Run this from the repository root.');
}

console.log(`\nscanned ${scanned} files`);
if (suggestions.length > 0) {
  console.error('\nBUDGET should read:');
  for (const line of suggestions) console.error(line);
}
if (failures > 0) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('green');
