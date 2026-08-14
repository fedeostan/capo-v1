# First Contact on WhatsApp — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one screen to signup, between `/onboarding` and `/instalar`, that hands the manager into the WhatsApp channel — a prefilled message in their own language, opened by a button on mobile or a QR code on desktop — and confirms out loud when the message actually reaches Capo.

**Spec:** [`docs/superpowers/specs/2026-08-14-whatsapp-first-contact-design.md`](../specs/2026-08-14-whatsapp-first-contact-design.md)
**Issue:** [#84](https://github.com/fedeostan/capo-v1/issues/84)

**Architecture:** A `force-dynamic` server component builds the `wa.me` URL and the QR geometry (both server-side, so no encoder reaches the browser) and hands them to one client component that branches on device, holds the opt-in tick-box, and polls a server action. The action reads `profiles.last_inbound_at` — a column the WhatsApp webhook already stamps on every inbound manager message — which is why this feature adds **no migration and no new column**. Capo's reply is the existing agent driven by the existing `firstUse` prompt block; nothing in `packages/core` is touched.

**Tech Stack:** Next 16 App Router (React 19, server components + server actions), Tailwind v4, Supabase (RLS via `createUserClient`), `@capo/i18n` copy catalogs, `qrcode-generator` (new).

---

## Global Constraints

Every task's requirements implicitly include this section.

- **This repo has no test suite.** The correctness harness is `scripts/*-check.mts` — credential-free TypeScript files that run in CI. New pure logic in this plan is tested by adding assertions to `scripts/whatsapp-check.mts` and running `pnpm whatsapp-check`. Do **not** introduce a test framework.
- **CI merge gate:** `pnpm turbo lint typecheck build` plus `pnpm scheduler-check`, `pnpm guard-check`, `pnpm whatsapp-check`, `pnpm push-check`, `pnpm cache-check`, `pnpm cost-check` (`.github/workflows/ci.yml`). All must stay green.
- **Server-only env vars are read inside functions, never at module scope.** A module-scope read breaks `next build` in CI, where secrets are absent. (AGENTS.md.)
- **New env var:** `WHATSAPP_BUSINESS_NUMBER`, value `+351911097383`. Already added to Vercel and redeployed by Federico, 2026-08-14. It must also be added to the local `apps/web/.env.local` (see Task 0).
- **Dependency:** `qrcode-generator` `^2.0.4` — MIT, zero runtime dependencies, ships its own types at `dist/qrcode.d.ts` (do **not** add `@types/qrcode-generator`). Added to `apps/web`, used server-side only.
- **Copy lives in `@capo/i18n`, all three locales, never inline in a component.** `Catalog` is an interface, so a missing key in any dictionary is a `tsc` error — that is the mechanism, do not weaken it.
- **`packages/core` is not modified by this plan.** If a change seems to need it, the design has gone wrong (spec §7).
- **Only one `next build` may run per workspace root at a time** (Next 16 build lock). If the main checkout at `/Users/federicoostanbazan/Documents/capo-v1` is building, wait — do not run builds in parallel across worktrees. Never `tail` a turbo failure; read the whole output.
- **Migration `0030` is verified applied in production** (spec §8), so naming `last_inbound_at` in a `select` is safe.

---

## File Structure

### Create

| Path | Responsibility |
|---|---|
| `apps/web/lib/whatsapp-handshake.ts` | **Pure.** Build a `wa.me` URL from an E.164 number + text. No env, no network, no React — so `whatsapp-check` can assert it. |
| `apps/web/lib/qr.ts` | **Pure.** Wrap `qrcode-generator` into SVG geometry (`count`, `path`, `viewBox`). Returns a path string, never markup. |
| `apps/web/app/(public)/whatsapp/page.tsx` | Server component. Auth gate, env read, link + QR construction, phone lookup. |
| `apps/web/app/(public)/whatsapp/handshake.tsx` | Client component. Device branch, tick-box, polling, status line, skip. |
| `apps/web/app/(public)/whatsapp/actions.ts` | `checkWhatsAppArrival(optIn)` — the poll and the one consent write. |

### Modify

| Path | Change |
|---|---|
| `packages/i18n/src/catalog.ts` | Add the `whatsappHandshake` section to the `Catalog` interface. |
| `packages/i18n/src/dictionaries/{pt-PT,es-ES,en-US}.ts` | Fill it in, three times. |
| `apps/web/app/platform.ts` | Add `detectFormFactor()` / `useFormFactor()`. |
| `scripts/whatsapp-check.mts` | Assertions for the link builder, the QR geometry, and the copy. |
| `apps/web/package.json` | Add `qrcode-generator`. |
| `apps/web/app/(public)/onboarding/actions.ts` | Both success redirects `/instalar` → `/whatsapp`. |

---

## Task 0: Set up the worktree

**Files:** none committed.

- [ ] **Step 1: Copy the local environment file into this worktree**

The worktree has no `.env.local`; the main checkout does.

```bash
cp /Users/federicoostanbazan/Documents/capo-v1/apps/web/.env.local apps/web/.env.local
```

- [ ] **Step 2: Add the new variable to it**

```bash
printf '\nWHATSAPP_BUSINESS_NUMBER=+351911097383\n' >> apps/web/.env.local
```

- [ ] **Step 3: Confirm it is there and is git-ignored**

```bash
grep -c WHATSAPP_BUSINESS_NUMBER apps/web/.env.local && git status --porcelain apps/web/.env.local
```

Expected: prints `1`, and `git status` prints **nothing** (the file is ignored). If `git status` prints a line, stop — `.env.local` must never be committed.

- [ ] **Step 4: Install dependencies**

```bash
pnpm install
```

---

## Task 1: The `wa.me` link builder

The single piece of pure logic in this feature, and the one place a mistake is silent: a malformed link opens WhatsApp with no recipient, or with the message text missing, and looks fine in a screenshot.

**Files:**
- Create: `apps/web/lib/whatsapp-handshake.ts`
- Modify: `scripts/whatsapp-check.mts`

**Interfaces:**
- Consumes: nothing.
- Produces: `buildWhatsAppLink(businessNumber: string, text: string): string | null`

- [ ] **Step 1: Write the failing assertions**

Append to `scripts/whatsapp-check.mts`, immediately **above** the `// ── report ─────` block at the end of the file. Add the import at the top with the other `apps/web` imports (near the existing `import { withProgressNote } from '../apps/web/lib/whatsapp-feedback.ts';`):

```ts
import { buildWhatsAppLink } from '../apps/web/lib/whatsapp-handshake.ts';
```

Then the block:

```ts
// ── the onboarding handshake link (issue #84) ───────────────────────────────
// The wa.me URL a freshly signed-up manager taps or scans. Pure, so it is
// checkable here — and it needs checking, because every way it can be wrong is
// silent: a link with no digits opens WhatsApp with no recipient, and a link
// whose text was not encoded loses everything after the first '&'.
{
  const NUMBER = '+351911097383';
  const link = buildWhatsAppLink(NUMBER, 'Olá Capo!');
  eq('handshake — the link strips the + and keeps every digit', link?.split('?')[0], 'https://wa.me/351911097383');
  check('handshake — the link is https', link!.startsWith('https://'), link!);
  check('handshake — exactly one query separator', (link!.match(/\?/g) ?? []).length === 1, link!);
  check('handshake — no raw spaces survive encoding', !buildWhatsAppLink(NUMBER, 'a b c')!.includes(' '));

  // Formatting a human might paste in is tolerated; anything that is not E.164
  // is refused outright rather than guessed at.
  eq('handshake — spaces and dashes in the number are tolerated', buildWhatsAppLink('+351 911-097 383', 'x'), link!.replace(/\?.*$/, '?text=x'));
  eq('handshake — a number without a + is refused', buildWhatsAppLink('351911097383', 'x'), null);
  eq('handshake — an empty number is refused', buildWhatsAppLink('', 'x'), null);
  eq('handshake — a too-short number is refused', buildWhatsAppLink('+351', 'x'), null);

  // THE ONE THAT MATTERS. toSendTarget in apps/web/lib/whatsapp.ts is
  // deliberately unexported so no BSUID can reach phone-digit surgery; this
  // builder is a second front door onto the same hazard and must refuse the
  // same shape. A BSUID in a wa.me link would silently address nobody.
  eq('handshake — a BSUID is refused, never digit-stripped', buildWhatsAppLink('PT.13491208655302741918', 'x'), null);

  // The text must survive the round trip intact, in every locale — accents,
  // punctuation and the '?' that ends two of the three greetings.
  for (const locale of LOCALES) {
    const prefill = getCatalog(locale).whatsappHandshake.prefill;
    const url = new URL(buildWhatsAppLink(NUMBER, prefill)!);
    eq(`${locale} — the prefilled text round-trips through the link`, url.searchParams.get('text'), prefill);
    check(`${locale} — the prefill is not empty`, prefill.trim().length > 0, prefill);
  }

  // Three languages, three different messages. A copy-paste that left two
  // locales identical would be invisible in review and wrong in production.
  const prefills = LOCALES.map(l => getCatalog(l).whatsappHandshake.prefill);
  check('handshake — all three prefills differ', new Set(prefills).size === LOCALES.length, prefills.join(' | '));
}
```

- [ ] **Step 2: Run the check to verify it fails**

```bash
pnpm whatsapp-check
```

Expected: FAIL — the module `apps/web/lib/whatsapp-handshake.ts` does not exist, so `tsx` throws on the import before any assertion runs. (The catalog key does not exist yet either; that is Task 2 and is expected.)

- [ ] **Step 3: Write the implementation**

Create `apps/web/lib/whatsapp-handshake.ts`:

```ts
/**
 * The `wa.me` link a freshly signed-up manager taps (mobile) or scans (desktop)
 * to start their first WhatsApp conversation with Capo — issue #84.
 *
 * PURE on purpose: no env read, no network, no React. The business number is a
 * parameter rather than a `process.env` read inside here, so this file can be
 * imported by `scripts/whatsapp-check.mts` with no credentials and no
 * configuration, and so the env-read rule (inside the request, never at module
 * scope) stays the caller's problem and lives in exactly one place.
 *
 * ── Why this does its own digit-stripping ─────────────────────────────────
 * `toSendTarget` in ./whatsapp.ts does the same '+'-stripping and is
 * deliberately UNEXPORTED, so that no BSUID (`PT.13491208655302741918`) can
 * ever reach phone-digit surgery — a BSUID belongs in a `recipient` field, and
 * a BSUID stripped and placed in a `to` field addresses a stale number while
 * reporting success. Exporting it for this file would reopen exactly that door.
 *
 * So this builder validates E.164 FIRST and returns null for anything else,
 * which refuses a BSUID structurally rather than by convention: the shape has a
 * dot and letters and can never match. `pnpm whatsapp-check` pins that.
 */

/** WhatsApp's own click-to-chat host. Not configurable — it is Meta's. */
const WA_ME = 'https://wa.me';

/**
 * Build the click-to-chat URL, or null when `businessNumber` is not a phone
 * number we can address.
 *
 * Null rather than a throw: the only caller is a page in the middle of signup,
 * and the right answer to "this deployment has no business number configured"
 * is to skip the screen quietly, not to 500 the last step of onboarding.
 *
 * @param businessNumber Capo's own number in E.164 (`+351911097383`). Spaces,
 *   dashes, dots and brackets are tolerated because a human may paste it into
 *   an env var; the leading '+' is mandatory, matching `normalizePhone` in the
 *   onboarding and profile actions.
 * @param text What WhatsApp pre-fills into the composer. The manager can edit
 *   it before sending — this is an opening offer, not a submission.
 */
export function buildWhatsAppLink(businessNumber: string, text: string): string | null {
  const compact = businessNumber.replace(/[\s\-().]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(compact)) return null;
  // encodeURIComponent, not encodeURI: the text contains '?' and may contain
  // '&', either of which would truncate the message if left raw in a query.
  return `${WA_ME}/${compact.slice(1)}?text=${encodeURIComponent(text)}`;
}
```

- [ ] **Step 4: Run the check**

```bash
pnpm whatsapp-check
```

Expected: the link assertions PASS. The four `${locale}` assertions and the "all three prefills differ" assertion still FAIL with a TypeScript error on `whatsappHandshake` — that key arrives in Task 2. Do not fix it here and do not delete those assertions.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/whatsapp-handshake.ts scripts/whatsapp-check.mts
git commit -m "feat(whatsapp): the click-to-chat link a new manager taps (#84)

Pure builder for the wa.me URL that opens WhatsApp with the first message
already typed. Validates E.164 and returns null otherwise, which refuses a
BSUID structurally — the same hazard toSendTarget stays unexported to avoid.

Asserted in whatsapp-check: digit stripping, encoding, and that the text
survives the round trip in all three locales.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: The copy, in three languages

**Files:**
- Modify: `packages/i18n/src/catalog.ts`
- Modify: `packages/i18n/src/dictionaries/pt-PT.ts`
- Modify: `packages/i18n/src/dictionaries/es-ES.ts`
- Modify: `packages/i18n/src/dictionaries/en-US.ts`

**Interfaces:**
- Consumes: the assertions written in Task 1.
- Produces: `Catalog['whatsappHandshake']` with the exact keys below. Tasks 5 and 6 read every one of them.

- [ ] **Step 1: Add the section to the `Catalog` interface**

In `packages/i18n/src/catalog.ts`, insert immediately **after** the closing `};` of the `install: {` block (around line 601) and before `landing: {`:

```ts
  /**
   * The WhatsApp handshake screen (issue #84) — the step between the details
   * form and the install guide, where a new manager sends Capo its first
   * message.
   */
  whatsappHandshake: {
    title: string;
    subtitle: string;
    /**
     * What WhatsApp pre-fills into the composer. Sent BY the manager TO Capo,
     * so it is written in the first person and in the manager's own language.
     * It greets AND states an intent: Capo's `firstUse` prompt block already
     * knows how to run initial setup, and this hands it the cue directly
     * instead of opening with small talk it has to answer first.
     */
    prefill: string;
    /** Primary button, mobile. */
    openButton: string;
    /** Caption under the QR code, desktop. */
    qrHint: string;
    /** Secondary link under the QR code, desktop. */
    webLink: string;
    consentLabel: string;
    consentHint: string;
    /** Status line while nothing has arrived yet. */
    waiting: string;
    /** Status line the moment the message lands. */
    arrived: string;
    /**
     * Status line after 90 seconds of silence. A QUESTION, never an error —
     * the threshold can be wrong, and the most likely cause is a phone number
     * that does not match the manager's actual WhatsApp.
     */
    stalled(phone: string): string;
    /** Link to /perfil, shown only alongside `stalled`. */
    fixNumber: string;
    skip: string;
  };
```

- [ ] **Step 2: Fill in Portuguese**

In `packages/i18n/src/dictionaries/pt-PT.ts`, immediately after the `install: { … },` block:

```ts
  whatsappHandshake: {
    title: 'Fala com o Capo no WhatsApp',
    subtitle: 'O Capo trabalha no WhatsApp, como tu e a tua equipa. Envia-lhe a primeira mensagem e ele começa a preparar a tua obra.',
    prefill: 'Olá Capo! Acabei de me registar. Ajudas-me a começar?',
    openButton: 'Abrir o WhatsApp',
    qrHint: 'Aponta a câmara do telemóvel para o código.',
    webLink: 'Abrir no WhatsApp Web',
    consentLabel: 'Envia-me o resumo do dia às 07:00 no WhatsApp',
    consentHint: 'Podes desligar isto quando quiseres, no teu perfil.',
    waiting: 'À espera da tua mensagem…',
    arrived: 'O Capo recebeu a tua mensagem. Vê o WhatsApp. ✅',
    stalled: phone => `Ainda não chegou nada. O ${phone} é o número do teu WhatsApp?`,
    fixNumber: 'Corrigir o número',
    skip: 'Fazer isto mais tarde',
  },
```

- [ ] **Step 3: Fill in Spanish**

In `packages/i18n/src/dictionaries/es-ES.ts`, in the same position:

```ts
  whatsappHandshake: {
    title: 'Habla con Capo en WhatsApp',
    subtitle: 'Capo trabaja en WhatsApp, igual que tú y tu equipo. Envíale el primer mensaje y empezará a preparar tu obra.',
    prefill: '¡Hola Capo! Acabo de registrarme. ¿Me ayudas a empezar?',
    openButton: 'Abrir WhatsApp',
    qrHint: 'Apunta la cámara del móvil al código.',
    webLink: 'Abrir en WhatsApp Web',
    consentLabel: 'Envíame el resumen del día a las 07:00 por WhatsApp',
    consentHint: 'Puedes desactivarlo cuando quieras, en tu perfil.',
    waiting: 'Esperando tu mensaje…',
    arrived: 'Capo ha recibido tu mensaje. Mira WhatsApp. ✅',
    stalled: phone => `Todavía no ha llegado nada. ¿El ${phone} es el número de tu WhatsApp?`,
    fixNumber: 'Corregir el número',
    skip: 'Hacerlo más tarde',
  },
```

- [ ] **Step 4: Fill in English**

In `packages/i18n/src/dictionaries/en-US.ts`, in the same position:

```ts
  whatsappHandshake: {
    title: 'Talk to Capo on WhatsApp',
    subtitle: 'Capo works on WhatsApp, same as you and your crew. Send it the first message and it starts setting up your job.',
    prefill: 'Hi Capo! I just signed up. Can you help me get started?',
    openButton: 'Open WhatsApp',
    qrHint: 'Point your phone camera at the code.',
    webLink: 'Open in WhatsApp Web',
    consentLabel: 'Send me the day summary at 07:00 on WhatsApp',
    consentHint: 'You can turn this off any time, in your profile.',
    waiting: 'Waiting for your message…',
    arrived: 'Capo got your message. Check WhatsApp. ✅',
    stalled: phone => `Still nothing. Is ${phone} the number your WhatsApp runs on?`,
    fixNumber: 'Fix the number',
    skip: 'Do this later',
  },
```

- [ ] **Step 5: Run the check and the typecheck**

```bash
pnpm whatsapp-check && pnpm turbo typecheck
```

Expected: `whatsapp-check` prints `0 failures` — including the four per-locale assertions and the "all three prefills differ" assertion from Task 1. `typecheck` passes. If a dictionary is missing a key, `tsc` names it; that is the interface doing its job.

- [ ] **Step 6: Commit**

```bash
git add packages/i18n/src/catalog.ts packages/i18n/src/dictionaries
git commit -m "feat(i18n): copy for the WhatsApp handshake screen (#84)

The prefilled message greets and states an intent, so Capo's existing
firstUse block gets its cue on turn one instead of answering small talk.

The 90-second line is a question, not an error: the threshold can be wrong,
and the likely cause is a phone that is not the manager's WhatsApp number.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: QR geometry

**Files:**
- Modify: `apps/web/package.json`
- Create: `apps/web/lib/qr.ts`
- Modify: `scripts/whatsapp-check.mts`

**Interfaces:**
- Consumes: `buildWhatsAppLink` (Task 1), for the assertions.
- Produces: `qrGeometry(text: string): QrGeometry` where `interface QrGeometry { count: number; path: string; viewBox: string }`. Task 6 renders `<svg viewBox={qr.viewBox}><path d={qr.path} /></svg>`.

- [ ] **Step 1: Add the dependency**

```bash
pnpm --filter web add qrcode-generator@^2.0.4
```

Then confirm no `@types` package was pulled in and the lockfile moved:

```bash
grep -n "qrcode-generator" apps/web/package.json && git status --porcelain pnpm-lock.yaml
```

Expected: one line in `package.json` under `dependencies`, and `pnpm-lock.yaml` shows as modified.

- [ ] **Step 2: Write the failing assertions**

Append to `scripts/whatsapp-check.mts`, directly after the Task 1 block. Add the import beside the Task 1 import:

```ts
import { qrGeometry } from '../apps/web/lib/qr.ts';
```

Then:

```ts
// ── the desktop QR code (issue #84) ─────────────────────────────────────────
// A QR that encodes the wrong thing, or nothing, looks exactly like a QR that
// works. Nobody reviewing a screenshot can tell. These assertions are the only
// thing standing between a broken code and a manager pointing a camera at it.
{
  const link = buildWhatsAppLink('+351911097383', getCatalog('pt-PT').whatsappHandshake.prefill)!;
  const qr = qrGeometry(link);

  // Every QR version is 4n+17 modules square (21, 25, … 177). A count outside
  // that family means the encoder was misused, not that the link is long.
  check('qr — the module count is a real QR version', (qr.count - 17) % 4 === 0 && qr.count >= 21 && qr.count <= 177, String(qr.count));
  check('qr — the path is not empty', qr.path.length > 0);
  check('qr — the path is only SVG path commands', /^[Mmhvz0-9 .-]+$/.test(qr.path), qr.path.slice(0, 40));

  // The 4-module quiet zone is required by the QR spec, not decoration: many
  // scanners will not lock on without it. Baking it into viewBox is what stops
  // a caller from forgetting it.
  check('qr — the viewBox carries the 4-module quiet zone', qr.viewBox === `-4 -4 ${qr.count + 8} ${qr.count + 8}`, qr.viewBox);

  // Deterministic: the page is force-dynamic and re-renders per request, so a
  // non-deterministic encoder would hand two managers different codes for the
  // same link and make any bug here unreproducible.
  eq('qr — the same text yields the same path', qrGeometry(link).path, qr.path);
  check('qr — different text yields a different path', qrGeometry(`${link}x`).path !== qr.path);
}
```

- [ ] **Step 3: Run the check to verify it fails**

```bash
pnpm whatsapp-check
```

Expected: FAIL — `apps/web/lib/qr.ts` does not exist.

- [ ] **Step 4: Write the implementation**

Create `apps/web/lib/qr.ts`:

```ts
import qrcode from 'qrcode-generator';

/**
 * QR geometry for the desktop half of the WhatsApp handshake (issue #84).
 *
 * SERVER-SIDE ONLY, and that is the point of returning geometry rather than
 * markup: the caller renders `<svg viewBox={viewBox}><path d={path} /></svg>`,
 * so the encoder never enters the browser bundle and nothing here needs
 * `dangerouslySetInnerHTML`. qrcode-generator ships `createSvgTag()`, which
 * returns a markup STRING and would require exactly that — declined.
 */

/**
 * Four modules of blank margin, mandated by the QR specification. Many scanners
 * will not lock onto a code without it. It lives inside `viewBox` rather than
 * in the component's padding so a caller cannot render a code without it.
 */
const QUIET_ZONE = 4;

export interface QrGeometry {
  /** Modules per side, excluding the quiet zone. Always 4n+17. */
  count: number;
  /** One `M{col} {row}h1v1h-1z` subpath per dark module, concatenated. */
  path: string;
  /** `-4 -4 {count+8} {count+8}` — the grid plus the quiet zone. */
  viewBox: string;
}

/**
 * @param text What the code encodes. For this feature, the `wa.me` URL from
 *   `buildWhatsAppLink` — never anything tenant-specific: this code is
 *   identical for every manager in a given locale.
 *
 * Type number 0 lets the library pick the smallest version that fits.
 * Error-correction level 'M' (~15% recoverable) is the usual choice for a code
 * displayed on a clean screen; 'H' would make the code denser and harder to
 * scan from a phone held at arm's length, for redundancy a screen does not need.
 */
export function qrGeometry(text: string): QrGeometry {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();

  const count = qr.getModuleCount();
  const parts: string[] = [];
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) parts.push(`M${col} ${row}h1v1h-1z`);
    }
  }

  return {
    count,
    path: parts.join(''),
    viewBox: `${-QUIET_ZONE} ${-QUIET_ZONE} ${count + QUIET_ZONE * 2} ${count + QUIET_ZONE * 2}`,
  };
}
```

- [ ] **Step 5: Run the check**

```bash
pnpm whatsapp-check
```

Expected: `0 failures`.

If the import of `qrcode-generator` fails to resolve under `tsx`, do **not** delete the assertions — run `pnpm install` again so pnpm links `apps/web/node_modules/qrcode-generator`, and re-run.

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/lib/qr.ts scripts/whatsapp-check.mts
git commit -m "feat(whatsapp): QR geometry for the desktop handshake (#84)

qrcode-generator (MIT, zero deps, own types), used server-side only. Returns
an SVG path plus a viewBox that bakes in the spec's 4-module quiet zone, so
the encoder never reaches the browser and no caller can drop the margin many
scanners need to lock on.

Asserted in whatsapp-check: a real QR version, a well-formed path, the quiet
zone, and determinism — every failure mode here is invisible in a screenshot.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Form-factor detection

**Files:**
- Modify: `apps/web/app/platform.ts`

**Interfaces:**
- Consumes: the existing `subscribe` constant in that file.
- Produces: `type FormFactor = 'detecting' | 'mobile' | 'desktop'`, `detectFormFactor(): FormFactor`, `useFormFactor(): FormFactor`.

- [ ] **Step 1: Add the detector and the hook**

Append to `apps/web/app/platform.ts`, after `useDetectedPlatform`:

```ts
// ── form factor ─────────────────────────────────────────────────────────────
// A SECOND question, deliberately not folded into detectPlatform() above.
// That one answers "is this Apple, is this already installed" and is consumed
// by the install guide and the push card; this one answers "can this person
// scan a QR code with a different device, or are they holding the only screen
// they have". One function answering both would serve two callers with two
// unrelated needs, and the copy that drifted would be the one deciding whether
// a manager is shown a code they cannot possibly scan.

export type FormFactor = 'detecting' | 'mobile' | 'desktop';

/**
 * Coarse pointer AND real touch points — the pair, because either alone is
 * wrong somewhere: a touchscreen laptop reports touch points while being driven
 * by a mouse, and some desktop browsers report a coarse pointer under remote
 * display.
 *
 * This is a HEURISTIC and both misreadings degrade to something usable, which
 * is why the handshake screen shows a link on every device and adds the QR only
 * on desktop: a laptop misread as mobile still gets a working button (wa.me
 * opens WhatsApp Desktop or Web), and a tablet misread as desktop gets a code
 * it cannot scan PLUS the link underneath.
 */
export function detectFormFactor(): FormFactor {
  return window.matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0
    ? 'mobile'
    : 'desktop';
}

/** 'detecting' on the server pass, the real value after hydration. Same no-op
 *  subscription as useDetectedPlatform: none of this changes while the page is
 *  open. */
export function useFormFactor(): FormFactor {
  return useSyncExternalStore(subscribe, detectFormFactor, () => 'detecting' as FormFactor);
}
```

- [ ] **Step 2: Typecheck and lint**

```bash
pnpm turbo typecheck lint --filter web
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/app/platform.ts
git commit -m "feat(web): detect mobile vs desktop for the handshake screen (#84)

A separate question from detectPlatform() — that one answers 'is this Apple,
is this installed'; this answers 'is there a second device that could scan a
QR code'. Kept apart so neither caller inherits the other's rules.

Heuristic, and both misreadings degrade to a working link rather than a dead
end. See the comment for why the pair of signals rather than either alone.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: The arrival poll and the consent write

**Files:**
- Create: `apps/web/app/(public)/whatsapp/actions.ts`

**Interfaces:**
- Consumes: `requireAuth()` from `@capo/db/session` (returns `{ db, userId, companyId, locale, companyLocale, confirmPosture }`), `logEvent` from `@/lib/log`.
- Produces: `checkWhatsAppArrival(optIn: boolean): Promise<{ arrived: boolean }>`. Task 6 calls it on an interval.

- [ ] **Step 1: Write the action**

Create `apps/web/app/(public)/whatsapp/actions.ts`:

```ts
'use server';

import { requireAuth } from '@capo/db/session';
import { logEvent } from '@/lib/log';

/**
 * Has this manager's first WhatsApp message reached Capo yet — and, the moment
 * it has, record the morning-briefing permission they chose on the way in.
 * Issue #84.
 *
 * ── Why last_inbound_at is honest evidence ────────────────────────────────
 * `profiles.last_inbound_at` (migration 0030) is written by exactly one thing:
 * `stampLastInbound` in apps/web/app/api/whatsapp/route.ts, on a webhook
 * delivery whose sender Capo already resolved to THIS profile. So a value here
 * is proof of a complete round trip — the right number, reaching the right
 * account — and not merely that something was sent. Nothing else in the schema
 * answers that question: `messages` records turns, not deliveries, and
 * notification_log is the OUTBOUND ledger.
 *
 * ── Why the consent write lives here ──────────────────────────────────────
 * `whatsapp_opt_in_at` / `whatsapp_opt_out_at` are what hasWhatsAppConsent()
 * reads and what the 07:00 briefing fails CLOSED on. Writing them on page load
 * would manufacture consent out of a pre-ticked default, and writing them on
 * the button tap would leave every desktop signup with nothing, because the QR
 * path has no tap at all. Arrival is the one event both devices share, and it
 * is the strongest evidence this screen can ever have: they really did open a
 * WhatsApp thread with Capo, from their own device.
 */
export interface ArrivalState {
  arrived: boolean;
}

export async function checkWhatsAppArrival(optIn: boolean): Promise<ArrivalState> {
  // RLS, never getDb(). One row, the caller's own, under profiles_select_own /
  // profiles_update_own — the tenant boundary on this path is the same one
  // every page uses, and requireAuth() redirects rather than answering if the
  // session died mid-wait.
  const { db, userId, companyId } = await requireAuth();

  // Naming the column is safe here in a way it would not be in getAuthState:
  // 0030 is verified applied in production, and a 42703 on THIS query costs one
  // screen's confirmation rather than every authenticated page in the product.
  // It is logged for the same reason — the symptom of a missing column is a
  // manager who is told "still nothing" after a message that arrived perfectly,
  // and that must be greppable.
  const { data, error } = await db
    .from('profiles')
    .select('last_inbound_at')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    logEvent('handshake.arrival_read_failed', { companyId, userId, error: error.message });
    return { arrived: false };
  }
  if (!data?.last_inbound_at) return { arrived: false };

  // Marks, never clears — the two timestamps are compared and the later wins,
  // so withdrawing consent does not erase the record that it was once given.
  // Same shape as setWhatsAppConsent on /perfil. See 0025_whatsapp_optin.sql.
  const now = new Date().toISOString();
  const patch = optIn ? { whatsapp_opt_in_at: now } : { whatsapp_opt_out_at: now };
  const { error: consentError } = await db.from('profiles').update(patch).eq('id', userId);
  if (consentError) {
    // Swallowed deliberately: a failed consent write must not cost the manager
    // their confirmation, and the fail-closed direction (no recorded opt-in, no
    // proactive send) is the safe one. They can still tick the box on /perfil.
    logEvent('handshake.consent_write_failed', { companyId, userId, optIn, error: consentError.message });
  }

  logEvent('handshake.arrived', { companyId, userId, optIn, consentRecorded: !consentError });
  return { arrived: true };
}
```

- [ ] **Step 2: Typecheck and lint**

```bash
pnpm turbo typecheck lint --filter web
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add "apps/web/app/(public)/whatsapp/actions.ts"
git commit -m "feat(onboarding): watch for the manager's first WhatsApp message (#84)

Reads profiles.last_inbound_at, which only a resolved inbound webhook writes
— so a value there is proof of a working round trip, not merely that
something was sent.

Records the morning-briefing consent at that same moment: not on page load
(a pre-ticked default is not an act) and not on the button tap (the desktop
QR path has no tap). A failed consent write is swallowed and logged; the
fail-closed direction is the safe one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: The screen

**Files:**
- Create: `apps/web/app/(public)/whatsapp/page.tsx`
- Create: `apps/web/app/(public)/whatsapp/handshake.tsx`

**Interfaces:**
- Consumes: `buildWhatsAppLink` (Task 1), `qrGeometry` + `QrGeometry` (Task 3), `useFormFactor` (Task 4), `checkWhatsAppArrival` (Task 5), `Catalog['whatsappHandshake']` (Task 2).
- Produces: the route `/whatsapp`. Task 7 redirects to it.

- [ ] **Step 1: Write the server component**

Create `apps/web/app/(public)/whatsapp/page.tsx`:

```tsx
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireAuth } from '@capo/db/session';
import { getCatalog } from '@capo/i18n/catalog';
import { metadataTitle } from '@/lib/i18n';
import { logEvent } from '@/lib/log';
import { qrGeometry } from '@/lib/qr';
import { buildWhatsAppLink } from '@/lib/whatsapp-handshake';
import Handshake from './handshake';

// force-dynamic: this page reads a server-only env var and the caller's own
// profile row. A statically rendered version would bake in one manager's phone
// number and be built without the env var present.
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: await metadataTitle(t => t.whatsappHandshake.title) };
}

/**
 * The step between the details form and the install guide: hand the manager
 * into the WhatsApp channel, and confirm out loud when they arrive. Issue #84.
 *
 * requireAuth() is both the gate and the precondition. Unauthenticated →
 * /login, no profile row → /onboarding, and that second one is not merely
 * tidiness: Capo recognises an inbound WhatsApp message by matching the sender
 * against profiles.phone, so without that row this screen would invite someone
 * to message a Capo that structurally cannot answer them.
 *
 * (The proxy already refuses a session-less request — /whatsapp is absent from
 * PUBLIC_PATHS in packages/db/src/proxy-session.ts — so this is the second
 * lock, not the only one.)
 */
export default async function WhatsAppPage() {
  const { db, userId, companyId, locale } = await requireAuth();
  const t = getCatalog(locale);

  // Inside the request, never at module scope: a module-scope read of a
  // server-only variable breaks `next build`, where secrets are absent.
  const link = buildWhatsAppLink(process.env.WHATSAPP_BUSINESS_NUMBER ?? '', t.whatsappHandshake.prefill);
  if (!link) {
    // Skip the screen rather than render a button that goes nowhere: a dead
    // button on the last step of signup is worse than no step at all. Logged
    // because a silent skip would make a misconfigured deployment look like a
    // design decision.
    logEvent('handshake.no_business_number', { companyId });
    redirect('/instalar');
  }

  // The phone is shown ONLY in the 90-second "is this really your number?"
  // line. Its own query rather than widening getAuthState's: that one runs on
  // every authenticated page in the product and must not grow columns for one
  // screen's copy.
  const { data: profile } = await db.from('profiles').select('phone').eq('id', userId).maybeSingle();

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 pb-16">
      <div className="space-y-2 text-center">
        <p className="text-4xl">💬</p>
        <h1 className="text-2xl font-semibold">{t.whatsappHandshake.title}</h1>
        <p className="text-sm text-zinc-500">{t.whatsappHandshake.subtitle}</p>
      </div>
      <Handshake locale={locale} link={link} qr={qrGeometry(link)} phone={profile?.phone ?? ''} />
    </div>
  );
}
```

- [ ] **Step 2: Write the client component**

Create `apps/web/app/(public)/whatsapp/handshake.tsx`:

```tsx
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import { useFormFactor } from '@/app/platform';
import type { QrGeometry } from '@/lib/qr';
import { checkWhatsAppArrival } from './actions';

const POLL_MS = 3_000;
/** Generous against a healthy path that completes in ~2s. Past this the screen
 *  asks a QUESTION about the phone number — it never declares an error, because
 *  the threshold itself can be wrong. */
const GIVE_UP_MS = 90_000;
/** Long enough for the confirmation to be read, short enough not to stall. */
const CONFIRM_BEAT_MS = 1_500;

type Status = 'waiting' | 'arrived' | 'stalled';

export default function Handshake({
  locale,
  link,
  qr,
  phone,
}: {
  locale: Locale;
  link: string;
  qr: QrGeometry;
  phone: string;
}) {
  const t = getCatalog(locale).whatsappHandshake;
  const router = useRouter();
  const formFactor = useFormFactor();
  const [optIn, setOptIn] = useState(true);
  const [status, setStatus] = useState<Status>('waiting');

  // The poll reads the tick-box, but must not RESTART when it changes: a
  // restarted interval would reset the 90-second clock every time the manager
  // toggled the box. A ref keeps the value current without being a dependency.
  const optInRef = useRef(optIn);
  useEffect(() => {
    optInRef.current = optIn;
  }, [optIn]);

  useEffect(() => {
    if (status !== 'waiting') return;
    let cancelled = false;
    const startedAt = Date.now();
    const id = setInterval(async () => {
      if (Date.now() - startedAt >= GIVE_UP_MS) {
        if (!cancelled) setStatus('stalled');
        return;
      }
      try {
        const { arrived } = await checkWhatsAppArrival(optInRef.current);
        if (arrived && !cancelled) setStatus('arrived');
      } catch {
        // A transient failure must not end the wait. The next tick retries; the
        // 90-second ceiling is what bounds this, not an error count.
      }
    }, POLL_MS);
    // Stops on arrival, on give-up, and on unmount — a screen left open in a
    // background tab must not poll forever.
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [status]);

  useEffect(() => {
    if (status !== 'arrived') return;
    // replace, not push: the back button must not return them to a screen whose
    // job is done and which would start polling again.
    const id = setTimeout(() => router.replace('/instalar'), CONFIRM_BEAT_MS);
    return () => clearTimeout(id);
  }, [status, router]);

  // 'detecting' — the server pass and the moment before hydration — renders the
  // LINK alone. The link works on every device; the QR only works when there is
  // a second screen to scan it with. So the not-yet-known state is the safe one,
  // and a QR never flashes onto a phone that has no use for it.
  const desktop = formFactor === 'desktop';

  return (
    <div className="space-y-6">
      <label className="flex items-start gap-3 rounded-lg border border-zinc-500/30 px-3 py-2.5">
        <input
          type="checkbox"
          checked={optIn}
          onChange={e => setOptIn(e.target.checked)}
          className="mt-0.5 h-5 w-5 shrink-0 accent-orange-600"
        />
        <span className="text-sm">
          {t.consentLabel}
          <span className="mt-0.5 block text-xs text-zinc-500">{t.consentHint}</span>
        </span>
      </label>

      {desktop && (
        <div className="space-y-2">
          {/* White card and black modules in BOTH themes, deliberately. An
              inverted QR is legal but many scanners will not lock onto one, and
              a code that fails to scan looks identical to a code that works. */}
          <div className="mx-auto w-48 rounded-lg bg-white p-3">
            <svg viewBox={qr.viewBox} className="block h-full w-full" role="img" aria-label={t.qrHint}>
              <path d={qr.path} fill="#000000" />
            </svg>
          </div>
          <p className="text-center text-xs text-zinc-500">{t.qrHint}</p>
        </div>
      )}

      <a
        href={link}
        target="_blank"
        rel="noopener noreferrer"
        className={
          desktop
            ? 'block text-center text-sm text-zinc-500 underline'
            : 'block w-full rounded-lg bg-emerald-600 py-2.5 text-center font-semibold text-white active:bg-emerald-700'
        }
      >
        {desktop ? t.webLink : t.openButton}
      </a>

      {status === 'arrived' ? (
        <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-center text-sm text-emerald-700 dark:text-emerald-400">
          {t.arrived}
        </p>
      ) : status === 'stalled' ? (
        <div className="space-y-2">
          <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-center text-sm text-amber-700 dark:text-amber-400">
            {t.stalled(phone)}
          </p>
          <Link href="/perfil" className="block text-center text-sm underline">
            {t.fixNumber}
          </Link>
        </div>
      ) : (
        <p className="text-center text-sm text-zinc-500">{t.waiting}</p>
      )}

      <Link href="/instalar" className="block text-center text-sm text-zinc-500 underline">
        {t.skip}
      </Link>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck, lint and build**

```bash
pnpm turbo lint typecheck build --filter web
```

Expected: PASS. If another `next build` is running against `/Users/federicoostanbazan/Documents/capo-v1`, wait for it — the Next 16 build lock is per workspace root. Read the full output; never `tail` a turbo failure.

- [ ] **Step 4: See it in a browser**

Start the dev server and open the screen directly (the redirect from onboarding lands in Task 7):

- `preview_start` with `{ name: "web" }`
- `navigate` to `http://localhost:3000/whatsapp`

Sign in as Federico if prompted. Then verify:

1. `read_page` — the title, the subtitle, the tick-box (checked), the link, and one of the three status lines are all present.
2. `resize_window` `{ preset: "desktop" }`, reload, `computer {action:"screenshot"}` — the QR renders on a white card with the caption beneath and the *Open in WhatsApp Web* link below it.
3. `resize_window` `{ preset: "mobile" }`, reload, screenshot — **no QR**, and the green *Abrir o WhatsApp* button is full width.
4. `read_console_messages` `{ onlyErrors: true }` — expected empty.
5. `read_network_requests` — the poll fires roughly every 3 s and stops once the status line settles.
6. Check the link is right: `javascript_tool` → `document.querySelector('a[href^="https://wa.me"]').href`. Expected `https://wa.me/351911097383?text=Ol%C3%A1%20Capo!...`.

**On what the status line should say:** Federico's own profile has almost certainly been stamped by past WhatsApp messages, so the expected result is the **arrived** state and an automatic move to `/instalar` after ~1.5 s. That confirms the read, the confirmation and the redirect in one pass. It does **not** exercise the waiting-to-stalled path — that needs a profile with a null `last_inbound_at`, which only a genuinely new account has. That is the acceptance test in Task 7, and it belongs to Federico.

Do **not** manufacture the waiting state by writing `last_inbound_at = null` on a production profile. There is no staging database; that write would change which envelope the next 07:00 briefing uses for a real person.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(public)/whatsapp/page.tsx" "apps/web/app/(public)/whatsapp/handshake.tsx"
git commit -m "feat(onboarding): the WhatsApp handshake screen (#84)

Button on mobile, QR on desktop, prefilled in the manager's own language,
with a status line that says out loud when the message reaches Capo.

Three things that look like details and are not: the pre-hydration state
renders the link alone, so a QR never flashes onto a phone; the QR is black
on white in both themes, because an inverted code that fails to scan looks
identical to one that works; and the poll reads the tick-box through a ref so
toggling it cannot reset the 90-second clock.

A missing WHATSAPP_BUSINESS_NUMBER skips the screen and logs, rather than
rendering a button that goes nowhere.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Put the screen in the signup flow

**Files:**
- Modify: `apps/web/app/(public)/onboarding/actions.ts:43` and `:53`

**Interfaces:**
- Consumes: the `/whatsapp` route (Task 6).
- Produces: the finished flow. Nothing depends on this task.

- [ ] **Step 1: Redirect onboarding to the new screen**

In `apps/web/app/(public)/onboarding/actions.ts`, change **both** `/instalar` redirects to `/whatsapp`. The first is the already-onboarded double-submit branch; the second is the success path. Also update the comment above the second so it still describes what happens.

The double-submit branch becomes:

```ts
    // double-submit / already onboarded: just proceed into the app
    if (error.message.includes('profile already exists')) redirect('/whatsapp');
```

And the end of the function becomes:

```ts
  // Keep the hint cookie in step with what we just wrote to the DB, so the
  // signed-out surface and <html lang> agree from here on.
  (await cookies()).set(LOCALE_COOKIE, language, localeCookieOptions);

  // On to the WhatsApp handshake (issue #84), which then hands over to
  // /instalar. This step sits AFTER the profile row exists and not before, and
  // that ordering is load-bearing: Capo recognises an inbound WhatsApp message
  // by matching the sender against profiles.phone, which complete_onboarding
  // has only just written.
  redirect('/whatsapp');
```

- [ ] **Step 2: Confirm no `/instalar` redirect is left in that file**

```bash
grep -n "instalar\|whatsapp" "apps/web/app/(public)/onboarding/actions.ts"
```

Expected: two `redirect('/whatsapp')` lines, and no `/instalar`.

- [ ] **Step 3: Run the whole merge gate**

```bash
pnpm turbo lint typecheck build && pnpm scheduler-check && pnpm guard-check && pnpm whatsapp-check && pnpm push-check && pnpm cache-check && pnpm cost-check
```

Expected: all green. Read the full output.

- [ ] **Step 4: Commit**

```bash
git add "apps/web/app/(public)/onboarding/actions.ts"
git commit -m "feat(onboarding): send a new manager to WhatsApp before the install step (#84)

Signup now ends: details -> talk to Capo on WhatsApp -> install -> the app.

The new step sits after the details form and not before, because Capo
identifies an inbound message by matching the sender against profiles.phone
and complete_onboarding has only just written that row.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Write the acceptance test into the handover**

The one thing no automated check in this repo can cover is the round trip through Meta. Record it for Federico rather than claiming it passed:

> **Acceptance test (Federico, on the Vercel preview deploy).** Sign up with a
> brand-new email and a phone number that really is on WhatsApp. At the
> handshake screen, leave the 07:00 box ticked, tap the button, send the
> message unchanged. Expect: Capo replies introducing itself and asking about
> the first obra; the browser screen flips to the ✅ line within a few seconds
> and moves on to the install step. Then open `/perfil` and confirm the WhatsApp
> permission shows as granted.
>
> Then repeat once on a desktop browser, scanning the QR with a phone, to
> confirm the desktop half and that the consent write happens on a path with no
> button tap.
>
> If the screen sits on "waiting" while WhatsApp clearly received a reply, grep
> the deployment logs for `handshake.arrival_read_failed` and
> `whatsapp.last_inbound_stamp_failed` — between them those two say whether the
> column is unreadable or simply never written.

---

## Self-Review

**Spec coverage.** Every section maps to a task: §2 flow → Task 7; §3 screen contents, device branch, pre-detection state → Tasks 4 and 6; §3 prefilled text → Task 2; §4 confirmation and the polling contract → Task 5; §5 consent → Task 5; §6 files → all; §7 invariants — env read inside the request (Task 6 Step 1), missing-number skip (Task 6 Step 1), never mandatory (skip link, Task 6 Step 2), route protection inherited (Task 6 Step 1 comment), RLS on the poll (Task 5), `packages/core` untouched (no task touches it); §8 risks → the `0030` verification is already settled, device-detection degradation is Task 4's comment, the 90-second judgement is Task 2's copy and Task 6's constant.

**Placeholder scan.** No TBDs, no "add error handling", no "similar to Task N". Every code step carries the actual code.

**Type consistency.** `buildWhatsAppLink(businessNumber, text) → string | null` is defined in Task 1 and called with that arity in Tasks 1, 3 and 6. `qrGeometry(text) → QrGeometry { count, path, viewBox }` is defined in Task 3 and consumed as `qr.viewBox` / `qr.path` in Task 6. `checkWhatsAppArrival(optIn) → { arrived }` is defined in Task 5 and destructured as `{ arrived }` in Task 6. `useFormFactor() → 'detecting' | 'mobile' | 'desktop'` is defined in Task 4 and compared against `'desktop'` in Task 6. `Catalog['whatsappHandshake']` keys defined in Task 2 are exactly the keys read in Task 6 (`title`, `subtitle`, `prefill`, `openButton`, `qrHint`, `webLink`, `consentLabel`, `consentHint`, `waiting`, `arrived`, `stalled`, `fixNumber`, `skip`) and in Task 1's assertions (`prefill`).
