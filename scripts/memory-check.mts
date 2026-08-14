// Memory check — the deterministic half of issue #48's nightly consolidation.
//
// The night agent writes rows that are injected into EVERY future system prompt
// for a company, and nothing ever re-checks them. So a defect in the gate
// between the model's output and the database is not a wrong answer once — it is
// a wrong answer for ever, at a cost per message, with no error anywhere. That
// makes `filterCandidates` the highest-risk pure function this feature adds, and
// this file is the only thing in CI that can see it.
//
// It guards four failures, all silent:
//
//   1. A NAME GETTING THROUGH. Issue #62 is the worked example: a manager
//      renamed himself and Capo kept using the old surname for weeks, out of
//      frozen prose nothing re-checked. A memory is that trap with a longer
//      fuse. The prompt asks the model not to write names; this filter is what
//      makes it true.
//   2. DUPLICATES ACCUMULATING. Forty rephrasings of one fact crowd out
//      thirty-nine real ones under the read cap, and each costs tokens on every
//      message.
//   3. THE CAP NOT BINDING. `MAX_NEW_MEMORIES_PER_RUN` is the write-side growth
//      bound; a model returning fifteen items must still write five.
//   4. AN OVER-LENGTH ROW REACHING THE DATABASE. 0037's CHECK would reject it,
//      and on a background job a rejected insert is an exception, not a
//      retryable tool error.
//
// Credential-free and model-free, like its siblings. The visibility filter and
// the READ-side cap are asserted in `pnpm cache-check`, beside the prompt they
// bound.
//
// Run with `pnpm memory-check`. Exit 0 = green, 1 = at least one failure.

import {
  MAX_NEW_MEMORIES_PER_RUN,
  filterCandidates,
  mentionsForbiddenName,
  normalizeMemory,
  type ConsolidationCandidate,
} from '@capo/core/memory/consolidate';
import { MEMORY_CONTENT_MAX_CHARS, type MemoryRow } from '@capo/core/memory/prompt';

let failures = 0;
const lines: string[] = [];

function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures += 1;
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
}
function eq(label: string, actual: unknown, expected: unknown) {
  check(label, actual === expected, `got ${String(actual)}, want ${String(expected)}`);
}

const fact = (content: string): ConsolidationCandidate => ({ kind: 'fact', content });
const stored = (content: string): MemoryRow => ({
  kind: 'fact',
  content,
  created_at: '2026-01-01T00:00:00.000Z',
  profile_id: null,
});

// ── normalisation ───────────────────────────────────────────────────────────
// The fold two "same" memories have to share. Accents matter here because this
// product speaks three languages that disagree about them constantly.
eq('case is folded', normalizeMemory('Cliente Paga Tarde'), 'cliente paga tarde');
eq('accents are stripped', normalizeMemory('Prefere manhãs'), 'prefere manhas');
eq('punctuation is dropped', normalizeMemory('Paga tarde, sempre.'), 'paga tarde sempre');
eq('whitespace is collapsed', normalizeMemory('  paga   tarde  '), 'paga tarde');
eq('an empty string stays empty', normalizeMemory('   '), '');
eq(
  'two spellings of one fact normalise to the same string',
  normalizeMemory('O cliente prefere manhãs.'),
  normalizeMemory('o cliente prefere manhas'),
);

// ── the name guard (issue #62) ──────────────────────────────────────────────
const NAMES = ['Aníbal Gatsby', 'Construções Silva'];

check('a full profile name is caught', mentionsForbiddenName('O Aníbal Gatsby prefere manhãs', NAMES));
check(
  'a SURNAME alone is caught — the half a rename usually changes',
  mentionsForbiddenName('O Gatsby prefere manhãs', NAMES),
);
check('a first name alone is caught', mentionsForbiddenName('Anibal prefere manhas', NAMES));
check('accents do not evade the guard', mentionsForbiddenName('anibal prefere manhas', NAMES));
check('case does not evade the guard', mentionsForbiddenName('GATSBY prefere manhas', NAMES));
check('punctuation does not evade the guard', mentionsForbiddenName('Pergunta ao Gatsby, sempre.', NAMES));
check('the company name is caught in full', mentionsForbiddenName('A Construções Silva paga a 30 dias', NAMES));
check(
  'a memory naming nobody passes',
  !mentionsForbiddenName('O cliente prefere obras a norte', NAMES),
);
check(
  "a CREW member's name is deliberately NOT forbidden",
  !mentionsForbiddenName('O Zé é lento no azulejo', NAMES),
  'kind:"worker" memories exist precisely for this',
);
check(
  'a short token inside a name does not reject everything',
  !mentionsForbiddenName('O material tem de estar na obra de manhã', ['Ana de Sousa']),
  'tokens under four characters are skipped so "de"/"da" cannot match',
);
eq('an empty forbidden list rejects nothing', mentionsForbiddenName('qualquer coisa', []), false);
eq('a blank name in the list is ignored', mentionsForbiddenName('qualquer coisa', ['  ']), false);

// ── the gate ────────────────────────────────────────────────────────────────
{
  const { accepted, rejected } = filterCandidates([fact('Cliente paga a 60 dias')], [], NAMES);
  eq('a clean candidate is accepted', accepted.length, 1);
  eq('and nothing is rejected', rejected.duplicate + rejected.name + rejected.invalid, 0);
}

{
  // Against HISTORY: the same fact already stored, spelled differently.
  const { accepted, rejected } = filterCandidates(
    [fact('O cliente prefere manhãs.')],
    [stored('o cliente prefere manhas')],
    NAMES,
  );
  eq('a restatement of a stored memory is rejected', accepted.length, 0);
  eq('and counted as a duplicate', rejected.duplicate, 1);
}

{
  // Against ITSELF: two near-identical candidates inside ONE run. Without the
  // growing `seen` set this passes and writes the same fact twice on night one.
  const { accepted, rejected } = filterCandidates(
    [fact('Cliente paga a 60 dias'), fact('cliente paga a 60 dias!')],
    [],
    NAMES,
  );
  eq('two candidates saying the same thing collide with each other', accepted.length, 1);
  eq('and the second is counted as a duplicate', rejected.duplicate, 1);
}

{
  const { accepted, rejected } = filterCandidates([fact('O Gatsby quer fotos de tudo')], [], NAMES);
  eq('a candidate naming the manager is refused', accepted.length, 0);
  eq('and counted as a name', rejected.name, 1);
}

{
  const tooLong = fact('x'.repeat(MEMORY_CONTENT_MAX_CHARS + 1));
  const { accepted, rejected } = filterCandidates([tooLong], [], NAMES);
  eq('an over-length candidate never reaches the database', accepted.length, 0);
  eq('and counted as invalid', rejected.invalid, 1);
  // Exactly at the limit is legal — 0037's CHECK is `<=`.
  eq(
    'exactly MEMORY_CONTENT_MAX_CHARS is accepted',
    filterCandidates([fact('y'.repeat(MEMORY_CONTENT_MAX_CHARS))], [], NAMES).accepted.length,
    1,
  );
}

{
  const blank = filterCandidates([fact('   '), fact('...')], [], NAMES);
  eq('whitespace and punctuation-only candidates are refused', blank.accepted.length, 0);
}

{
  // The write-side growth bound. A model that ignores the schema's `.max()` must
  // still not be able to write more than the cap.
  const many = Array.from({ length: MAX_NEW_MEMORIES_PER_RUN * 3 }, (_, i) => fact(`facto numero ${i}`));
  const { accepted } = filterCandidates(many, [], NAMES);
  eq('the per-run cap binds', accepted.length, MAX_NEW_MEMORIES_PER_RUN);
}

{
  // Content is TRIMMED on the way through, so the stored row and the string the
  // dedup ran on cannot differ by whitespace.
  const { accepted } = filterCandidates([fact('  cliente paga tarde  ')], [], NAMES);
  eq('accepted content is trimmed', accepted[0]?.content, 'cliente paga tarde');
}

eq('no candidates writes nothing', filterCandidates([], [stored('x')], NAMES).accepted.length, 0);

// ── report ──────────────────────────────────────────────────────────────────
console.log(lines.join('\n'));
console.log(`\nMemory check: ${lines.length - failures}/${lines.length} passed; failures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
