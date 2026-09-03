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
 *
 * ── Why this reads block-comment STATE and not the first character ─────────
 *
 * The first version of this filter dropped every line whose first
 * non-whitespace was `//`, `*` or a block-comment opener. The `*` was there to
 * catch a JSDoc continuation line. It also caught this, which is not a comment
 * at all but live instruction text sent to the model on every single turn:
 *
 *     **When the two disagree, the live fact wins — every time, silently.**
 *
 * The prompt files are Markdown inside template literals, so a bold run, a
 * bold heading and a `*` bullet all begin with the very character the filter
 * was using as its proof of a comment. Every long dash in the orchestration
 * policy sat on a line like that, and the gate reported the file green at
 * zero: the one file the whole finding was about was the one file the gate
 * could not see.
 *
 * Tightening the pattern instead (a JSDoc `*` is followed by a space or the
 * end of the line; a bold run is `**` followed by a non-space) would have
 * fixed that one example and left the class of bug standing, because a
 * Markdown bullet is also `*` followed by a space and is indistinguishable
 * from a JSDoc line by appearance alone. The character a line starts with is
 * not evidence about what the line IS. Where the line sits, inside a comment
 * block or outside one, is evidence, so that is what is read here: a line
 * inside a block comment is a comment whatever it starts with, and a line
 * outside one is content whatever it starts with.
 *
 * Two deliberate pieces of conservatism, both in the direction of counting too
 * much rather than too little:
 *
 *   A block is only ever ENTERED from a line whose first non-whitespace opens
 *   one, which is what the old filter already assumed, so an opener appearing
 *   mid-line inside a string cannot black out the file behind it.
 *
 *   A block that is opened and never closed would hide everything after it in
 *   exactly the way the old filter hid those prompt lines, silently. It is
 *   reported to the caller and fails the file instead of being counted.
 */
type Stripped = { text: string; unterminated: boolean };

function stringsOnly(body: string): Stripped {
  const kept: string[] = [];
  let inBlock = false;

  for (const line of body.split('\n')) {
    if (inBlock) {
      if (line.includes('*/')) inBlock = false;
      continue;
    }

    const trimmed = line.trimStart();

    if (trimmed.startsWith('//')) continue;

    if (trimmed.startsWith('/*')) {
      // A block opened and closed on the same line is just a one-line comment.
      if (!line.includes('*/', line.indexOf('/*') + 2)) inBlock = true;
      continue;
    }

    kept.push(line);
  }

  return { text: kept.join('\n'), unterminated: inBlock };
}

/**
 * The filter above guards the rest of this file, and nothing guards the
 * filter. It shipped with a blind spot that made the gate report zero on the
 * file it was written for, so its two halves are asserted here, on a fixture,
 * before a single real file is opened: a comment must be dropped and Markdown
 * must survive. A gate that cannot see the text it is scanning is worse than
 * no gate, because it reports green while it does it.
 */
function checkTheFilter(): void {
  const fixture = [
    '/**',
    ' * A JSDoc line with a — dash in it.',
    ' * @param x nothing',
    ' */',
    '// A whole-line comment with a — dash in it.',
    'export const block = `',
    '**A bold Markdown heading — kept.**',
    '* A Markdown bullet — kept.',
    'Ordinary prompt text — kept.',
    '`;',
  ].join('\n');

  const stripped = stringsOnly(fixture);
  const found = (stripped.text.match(DASHES) ?? []).length;

  if (stripped.unterminated) fail('the comment filter lost track of a closed block comment.');
  if (found !== 3) {
    fail(
      `the comment filter counted ${found} dash(es) in its own fixture, expected 3 (the two comment lines dropped, the three Markdown lines kept).`,
    );
  }
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
    const stripped = stringsOnly(readFileSync(file, 'utf8'));

    if (stripped.unterminated) {
      fail(`${file}: a block comment is opened and never closed, so everything after it would be dropped unread. Refusing to count this file.`);
      continue;
    }

    const found = (stripped.text.match(DASHES) ?? []).length;
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
checkTheFilter();
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
