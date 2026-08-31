// Plan materials quality — the pure checker behind the plan card's warning
// section (issue #119).
//
// A generated plan's materials land on the buying list and in the crew's 07:00
// message with no scrutiny at all: whatever the model wrote is what is stored.
// The two defects that actually reached Federico were "Tiles" and "Tiles 30x60"
// as separate purchases, and two tiling tasks of which only one listed grout.
// This module turns both from a silent mistake into a question on the approval
// card. It only ever WARNS — the card still proposes, approving is always
// possible, and nothing here mutates the plan (Federico's decision on #119).
//
// Pure on purpose, like ./reschedule.ts: no Db, no Date.now(), no locale, no
// model call. That is what lets scripts/scheduler-check.mts pin every
// heuristic below in CI with no credentials. The wording lives in ./cards; the
// only string knowledge here is how to compare material names.

export interface PlanQualityTask {
  title: string;
  /** Model-authored, optional — a task without one is never trade-compared. */
  trade?: string | null;
  materials?: string[] | null;
}

export type PlanWarning =
  /** Names that look like ONE material written several ways ("Azulejo",
   *  "azulejo 30x60"). The buy list aggregates identical strings, so each
   *  spelling becomes its own line to buy. Raw spellings, first-seen order. */
  | { kind: 'material_name_variants'; names: string[] }
  /** A same-trade sibling doing the same work lists consumables this task
   *  does not — the "two tiling tasks, only one has grout" case. `missing`
   *  carries the sibling's own spellings. */
  | { kind: 'trade_materials_gap'; trade: string; title: string; missing: string[] };

/** Case-, accent- and whitespace-insensitive comparison form. */
function normalizeName(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function tokensOf(normalized: string): Set<string> {
  return new Set(normalized.split(' '));
}

function isSubset(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) if (!b.has(t)) return false;
  return true;
}

/** Exactly one edit apart (substitution, insertion or deletion). Full
 *  Levenshtein would be overkill for a distance capped at 1. */
function oneEditApart(a: string, b: string): boolean {
  if (a === b) return false;
  const [s, l] = a.length <= b.length ? [a, b] : [b, a];
  if (l.length - s.length > 1) return false;
  let i = 0;
  while (i < s.length && s[i] === l[i]) i += 1;
  return s.length === l.length ? s.slice(i + 1) === l.slice(i + 1) : s.slice(i) === l.slice(i + 1);
}

/** Letters only, and long enough that one edit is a typo rather than a
 *  different word — "cal" vs "cola" must never match. Digit-carrying tokens
 *  are excluded on purpose: "prego 40mm" vs "prego 60mm" is one character
 *  apart and is two genuinely different purchases. */
function typoComparable(token: string): boolean {
  return token.length >= 4 && /^[a-z]+$/.test(token);
}

/** Would a person standing in the shop ask whether these are one material or
 *  two? Deliberately conservative: "tinta branca" vs "tinta azul" (each side
 *  has a token the other lacks) is two materials and must not be flagged. */
function looksLikeVariantPair(aNorm: string, bNorm: string): boolean {
  if (aNorm === bNorm) return true;
  const aTokens = tokensOf(aNorm);
  const bTokens = tokensOf(bNorm);
  // One name wholly contained in the other: "azulejo" vs "azulejo 30x60".
  if (isSubset(aTokens, bTokens) || isSubset(bTokens, aTokens)) return true;
  // Same name give or take one typo/plural token: "cimento" vs "cemento".
  const onlyA = [...aTokens].filter(t => !bTokens.has(t));
  const onlyB = [...bTokens].filter(t => !aTokens.has(t));
  return (
    onlyA.length === 1 &&
    onlyB.length === 1 &&
    typoComparable(onlyA[0]) &&
    typoComparable(onlyB[0]) &&
    oneEditApart(onlyA[0], onlyB[0])
  );
}

export function checkPlanQuality(tasks: PlanQualityTask[]): PlanWarning[] {
  // Every distinct raw spelling in the plan, in first-seen order. The raw
  // string is what the manager reads and what the buy list aggregates on, so
  // it is the unit warnings are phrased in; the normalized form is only how
  // spellings are compared.
  const rawNames: string[] = [];
  const rawIndex = new Map<string, number>();
  for (const task of tasks) {
    for (const material of task.materials ?? []) {
      const raw = material.trim();
      if (!raw || rawIndex.has(raw)) continue;
      rawIndex.set(raw, rawNames.length);
      rawNames.push(raw);
    }
  }

  // Union-find over spellings, so "Tiles", "tiles" and "Tiles 30x60" come out
  // as ONE question with three names, not three questions about pairs.
  const parent = rawNames.map((_, i) => i);
  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }
  const norms = rawNames.map(normalizeName);
  for (let a = 0; a < rawNames.length; a += 1) {
    for (let b = a + 1; b < rawNames.length; b += 1) {
      if (looksLikeVariantPair(norms[a], norms[b])) parent[find(b)] = find(a);
    }
  }

  const clusters = new Map<number, string[]>();
  for (let i = 0; i < rawNames.length; i += 1) {
    const root = find(i);
    const members = clusters.get(root) ?? [];
    members.push(rawNames[i]);
    clusters.set(root, members);
  }

  const warnings: PlanWarning[] = [];
  for (const i of rawNames.keys()) {
    const members = clusters.get(i);
    if (members && members.length >= 2) warnings.push({ kind: 'material_name_variants', names: members });
  }

  // Same-trade consumable gaps. A task "has" a material when it lists ANY
  // spelling in that material's variant cluster — a task carrying "azulejo"
  // is not missing "azulejo 30x60", that pair is already the question above.
  const clusterKeyOf = (raw: string): number => find(rawIndex.get(raw.trim()) ?? 0);
  const byTrade = new Map<string, { trade: string; task: PlanQualityTask }[]>();
  for (const task of tasks) {
    const trade = task.trade?.trim();
    if (!trade) continue;
    const key = normalizeName(trade);
    const group = byTrade.get(key) ?? [];
    group.push({ trade, task });
    byTrade.set(key, group);
  }

  for (const group of byTrade.values()) {
    // A task with no materials at all is skipped, not flagged: the model
    // sometimes legitimately puts a phase's materials on its main task, and
    // "missing everything" would drown the real signal.
    const candidates = group.filter(g => (g.task.materials ?? []).some(m => m.trim()));
    if (candidates.length < 2) continue;
    const coverage = candidates.map(
      g => new Set((g.task.materials ?? []).filter(m => m.trim()).map(clusterKeyOf)),
    );
    for (let x = 0; x < candidates.length; x += 1) {
      const missingKeys: number[] = [];
      for (let y = 0; y < candidates.length; y += 1) {
        if (y === x) continue;
        // Only compare siblings that share at least one material: two tasks
        // under one trade can be different sub-phases (rough-in vs fixtures),
        // and those legitimately carry disjoint lists.
        if (![...coverage[y]].some(k => coverage[x].has(k))) continue;
        for (const key of coverage[y]) {
          if (!coverage[x].has(key) && !missingKeys.includes(key)) missingKeys.push(key);
        }
      }
      if (missingKeys.length > 0) {
        missingKeys.sort((a, b) => a - b);
        warnings.push({
          kind: 'trade_materials_gap',
          trade: candidates[x].trade,
          title: candidates[x].task.title,
          // The cluster's first-seen spelling, which is also the sibling's own.
          missing: missingKeys.map(k => rawNames[k]),
        });
      }
    }
  }

  return warnings;
}

/** The wording the renderer hands in — structurally satisfied by
 *  CardStrings['plan']['warnings'], with no import either way, so this module
 *  stays a leaf the check script can load with nothing behind it. */
export interface PlanWarningStrings {
  header: string;
  nameVariants(names: string[]): string;
  tradeGap(p: { trade: string; title: string; missing: string[] }): string;
}

/** The card's warning section as lines, or NOTHING — never an empty header.
 *  An empty return is what keeps a clean plan's card byte-identical to what
 *  it rendered before #119. */
export function renderPlanWarningLines(warnings: PlanWarning[], t: PlanWarningStrings): string[] {
  if (warnings.length === 0) return [];
  return [
    t.header,
    ...warnings.map(w =>
      w.kind === 'material_name_variants'
        ? t.nameVariants(w.names)
        : t.tradeGap({ trade: w.trade, title: w.title, missing: w.missing }),
    ),
  ];
}
