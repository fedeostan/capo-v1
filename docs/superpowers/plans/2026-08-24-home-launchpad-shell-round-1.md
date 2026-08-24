# Home Launchpad Shell — Round 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Capo a persistent top bar and a profile drawer leading to five settings rooms, move Materiais behind a switch on Obras, and reorder the bottom bar to four tabs — without changing any screen's data or adding a migration.

**Architecture:** Everything renders inside the existing `(app)` shell. The top bar and drawer become siblings of the `overflow-hidden` content column in `(app)/layout.tsx`, alongside the two banner strips, so nothing can clip them. `/perfil` splits into four sibling routes plus the existing `/subscricao`, keeping every settings form as a plain server-action `<form>` so the no-JavaScript save path survives. The drawer reuses `Sheet`'s focus trap through a hook extracted in Task 1, rather than growing a second copy.

**Tech Stack:** Next 16 App Router (read `node_modules/next/dist/docs/` before using any API you are unsure of — this version has breaking changes versus older training data), React 19, Tailwind v4 with `@capo/ui/tokens.css`, `@capo/i18n` catalogs, Supabase RLS clients.

**Spec:** `docs/superpowers/specs/2026-08-24-home-launchpad-shell-design.md` — read it before Task 1. Section 3 (what the handoff asks for that Capo lacks) and section 5 (invariants) are the two an implementer must not skip.

---

## Global Constraints

These apply to **every** task. They are not repeated per task.

- **There is no test suite, and you must not add one.** `AGENTS.md` is explicit: the only automated correctness check is `pnpm scheduler-check`, and proposing a test suite is a non-blocking follow-up, never part of a PR. The verification cycle for every task in this plan is: `pnpm turbo typecheck` → `pnpm turbo lint` → `pnpm design-check` → `pnpm turbo build` → visual check at `/design-system/screens`. Where a task has a behaviour no gate can see, the plan names an explicit manual check.
- **Serialize `next build` across worktrees.** Only one `next build` may run per workspace root at a time. Never `tail` a turbo failure — read the whole output.
- **Tokens outrank the prototype.** The handoff prints hex values and raw easing curves "for preview safety" and says in its own README to use the codebase's tokens instead. Use `--brand`, `--fg-muted`, `rounded-control`, `duration-(--duration-slow)`, `ease-out`. Do **not** transcribe `cubic-bezier(0.32, 0.72, 0, 1)` or `#c2410c` — `pnpm design-check`'s `arbitrary-colour` and `raw-palette` rules exist to catch exactly that.
- **`--fg*` for text colour, never `--text*`.** Tailwind v4 owns `--text-*` as its font-size namespace.
- **There is no `--duration-*` theme namespace**, so `duration-fast` is not a utility and fails silently. Use `duration-(--duration-fast|base|slow)` or bare `transition-colors` (180ms).
- **Never put `@utility` in `tokens.css`** — Tailwind discards the entire imported file with no error.
- **No route folder may start with an underscore.** `apps/web/app/_ui/` is legal because it holds components, not routes.
- **Locale is a prop, per component. There is no provider.** Every new screen takes `locale` and resolves its own catalog with `getCatalog(locale)`.
- **Import `ListRow`, `ButtonLink`, `Banner`, `AppBar` from `@/app/_ui/nav`**, never from `@capo/ui/*` directly. The nav wrapper binds `next/link`; importing directly gives a plain `<a>`, which is a full document reload that tears down and re-runs the shell's auth, billing and unread queries — and `tsc`, `lint`, `design-check` and `next build` all stay green while it happens.
- **`(app)/layout.tsx` is never the auth gate.** A layout persists across client navigations. Auth is per-route via `requireAuth()` / `requireAuthT()`. Anything the layout reads must be opportunistic and must render nothing rather than throw when there is no session.
- **Every tap target ≥44px** (`min-h-11 min-w-11`), and every icon-only control carries an `aria-label` resolved from the catalog — never a hardcoded English string. Capo speaks three languages.
- **`pnpm design-check`'s `UNCONVERTED` ledger may only ever shrink, and a stale entry fails too.** See the note below — this constrains Task 3 hard.

### The UNCONVERTED ledger constrains Task 3, and this was not in the spec

`scripts/design-check.mts` enforces two things about its allowlist:

1. every listed file must **still** violate a rule (a clean entry fails as stale), and
2. `stillDirty.size <= UNCONVERTED.length` — the count of dirty files may never exceed the ledger's length.

`apps/web/app/(app)/perfil/page.tsx` is on that ledger (line 281) and is dirty: its local `Card` uses `border-zinc-500/20` and `text-zinc-500`. Splitting one dirty file into five dirty files takes `stillDirty.size` four above `UNCONVERTED.length` and **fails the build gate**.

So the split **forces** the four new rooms onto the design system. The spec's §7 mitigation ("move the cards verbatim, no rewrite, in the same commit") and this gate are in direct tension. Task 3 resolves it by splitting the work across **two commits in one PR**: commit A is a pure verbatim move (reviewable as a move, `design-check` red), commit B is styling only (reviewable as a conversion, `design-check` green). The PR-level gate is what CI runs, so this is legal, and it preserves the property the spec's mitigation was protecting — that a reviewer can verify nothing about the forms changed.

Net effect on the ledger: `apps/web/app/(app)/perfil/page.tsx` is **deleted** from `UNCONVERTED`. It shrinks by one.

---

## File Structure

**New**

| File | Responsibility |
|---|---|
| `apps/web/app/_ui/use-overlay.ts` | Focus trap, escape-to-close, scroll lock, client-mount gate. Consumed by `Sheet` and `ProfileDrawer`. No markup. |
| `apps/web/app/_ui/top-bar.tsx` | The persistent bar. Owns drawer open state. Self-hides on non-tab routes. |
| `apps/web/app/_ui/profile-drawer.tsx` | The left drawer: header, five rows, install card, footer. Pure presentation over props. |
| `apps/web/app/_ui/tab-screen.tsx` | `ScreenShell` minus `AppBar` — the max-w-2xl column with the title as an in-scroller heading. For tab roots only. |
| `apps/web/app/(app)/perfil/pessoal/page.tsx` | Company + account forms. |
| `apps/web/app/(app)/perfil/equipa/page.tsx` | The crew list. |
| `apps/web/app/(app)/perfil/privacidade/page.tsx` | Memory, notifications, WhatsApp consent. |
| `apps/web/app/(app)/perfil/definicoes/page.tsx` | Language, appearance, confirm posture, automations, app version, delete row. |
| `apps/web/app/(app)/perfil/definicoes/delete-account-sheet.tsx` | The inert delete sheet. |

**Modified**

| File | Change |
|---|---|
| `apps/web/app/_ui/sheet.tsx` | Consumes `use-overlay.ts`; behaviour unchanged. |
| `apps/web/app/(app)/layout.tsx` | Renders `TopBar` as a sibling of the banner strips. |
| `apps/web/app/_ui/tab-bar.tsx` | Four tabs, new order, `grid-cols-4`. |
| `apps/web/app/(app)/perfil/page.tsx` | Becomes the five-row list. |
| `apps/web/app/(app)/obras/page.tsx` | Gains the `Obras \| Materiais` switch. |
| `apps/web/app/(app)/materiais/page.tsx` | Becomes a redirect. |
| `apps/web/app/(app)/tarefas/page.tsx` | Uses `TabScreen` instead of `ScreenShell`. |
| `apps/web/app/(app)/page.tsx` | Reads `voice` / `compose` search params. |
| `apps/web/app/chat.tsx` | Accepts them. |
| `packages/i18n/src/catalog.ts` + 3 dictionaries | New keys. |
| `scripts/design-check.mts` | `UNCONVERTED` shrinks by one. |
| `apps/web/app/design-system/screens/` | New shell cases. |
| `AGENTS.md` | The `/definicoes` statement and the tab-bar rationale. |

---

### Task 1: Extract the overlay hook from Sheet

A pure refactor with no behaviour change. It exists so the drawer in Task 6 cannot grow a second focus trap — two copies of a focus trap is how one of them silently stops working, and nothing in this repo's gate would notice.

**Files:**
- Create: `apps/web/app/_ui/use-overlay.ts`
- Modify: `apps/web/app/_ui/sheet.tsx:1-130` (the four `useEffect`s and the `mounted` gate move out; the JSX stays)

**Interfaces:**
- Consumes: nothing.
- Produces: `useOverlay({ open, onClose }): { mounted: boolean; panel: RefObject<HTMLDivElement | null> }` — `mounted` is false during the server pass and the first client render, true after; `panel` must be attached to the dialog element.

- [ ] **Step 1: Create the hook**

```ts
'use client';

// The behaviours every overlay in this app must have, in one place. Extracted
// from sheet.tsx unchanged — see that file's banner for the five failures each
// of these prevents. It lives here rather than in @capo/ui because it is
// entirely browser behaviour and that package is 'use client'-free by contract.
import { useCallback, useEffect, useRef, useSyncExternalStore, type RefObject } from 'react';

// Nothing here ever changes; the point is the getServerSnapshot/getClientSnapshot
// split, which lets React answer `false` for the server pass and the first
// client render (so hydration matches) and `true` once mounted, with no
// setState call for the React Compiler lint to reject.
const subscribe = () => () => {};

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useOverlay({ open, onClose }: { open: boolean; onClose: () => void }): {
  mounted: boolean;
  panel: RefObject<HTMLDivElement | null>;
} {
  const panel = useRef<HTMLDivElement>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  const mounted = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );

  const focusables = useCallback(
    () => Array.from(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []),
    [],
  );

  // `mounted` is in the deps deliberately. Without it, an overlay that is
  // already open on the first render (a URL param, server-seeded state) runs
  // this effect while the panel is still null — first?.focus() no-ops — and
  // never runs it again, because flipping `mounted` would not change the deps.
  useEffect(() => {
    if (!open) return;
    returnTo.current = document.activeElement as HTMLElement | null;
    const first = focusables()[0] ?? panel.current;
    first?.focus();
    return () => returnTo.current?.focus();
  }, [open, mounted, focusables]);

  // Escape closes, and Tab cycles inside. The trap is a wrap-around rather
  // than a barrier.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables();
      // Nothing focusable inside: keep Tab on the panel rather than letting
      // the browser walk into the page behind. tabIndex={-1} makes the panel
      // programmatically focusable but absent from the sequential tab order,
      // so without this the trap has a hole exactly when it is emptiest.
      if (items.length === 0) {
        e.preventDefault();
        panel.current?.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose, focusables]);

  // Lock the page behind. The shell already sets overflow:hidden on body, so
  // the thing that actually moves is the inner scroller — but locking body as
  // well costs nothing and covers a route that added its own.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  return { mounted, panel };
}
```

- [ ] **Step 2: Rewrite `sheet.tsx` to consume it**

Delete the `subscribe` const, `FOCUSABLE`, both refs, `mounted`, `focusables`, and all four `useEffect`s. Replace the top of the component body with:

```tsx
'use client';

// The bottom sheet. The four hand-rolled ones it replaces have, between them,
// none of the behaviours in use-overlay.ts — see that file. It lives in
// apps/web rather than @capo/ui because it genuinely needs to react; @capo/ui
// is 'use client'-free by contract.
import { type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useOverlay } from './use-overlay';

export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const { mounted, panel } = useOverlay({ open, onClose });

  if (!open || !mounted) return null;
  // ...the existing createPortal(...) JSX, unchanged, still using `panel` as
  // the dialog's ref.
}
```

Leave the JSX byte-identical. This task changes no rendered output.

- [ ] **Step 3: Verify the refactor changed nothing**

```bash
pnpm turbo typecheck && pnpm turbo lint && pnpm design-check
```

Expected: all pass. `design-check` must report the same failure count as before this task — run it on `HEAD` first and write the number down if unsure.

- [ ] **Step 4: Manual check — the trap still traps**

`pnpm dev`, open `/tarefas`, open a task, open the completion sheet. Confirm: Escape closes it; Tab from the last control returns to the first rather than reaching the page behind; closing returns focus to the button that opened it. **Nothing automated covers any of these three.**

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/_ui/use-overlay.ts apps/web/app/_ui/sheet.tsx
git commit -m "refactor(ui): lift Sheet's overlay behaviour into a hook the drawer can share

Focus trap, escape, scroll lock and the client-mount gate move out of
sheet.tsx unchanged. No rendered output changes. Extracted rather than
copied because the profile drawer needs the identical four behaviours, and
two copies of a focus trap is how one of them silently stops working — a
failure no gate in this repo can see.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Catalog keys for the shell

Every user-facing string in Tasks 3–8 comes from here. Doing it first means those tasks are compile-checked against real keys rather than inventing them.

**Files:**
- Modify: `packages/i18n/src/catalog.ts` (the `nav` type at line 31, plus a new `shell` block)
- Modify: `packages/i18n/src/dictionaries/pt-PT.ts:14`, `es-ES.ts`, `en-US.ts`

**Interfaces:**
- Produces: `Catalog['nav']` gains `home` and `activity`. New `Catalog['shell']` block, consumed by Tasks 3, 6, 7 and 8.

- [ ] **Step 1: Extend the `Catalog` type**

In `packages/i18n/src/catalog.ts`, replace the `nav` line and add `shell` beneath it:

```ts
  nav: {
    home: string;
    chat: string;
    tasks: string;
    jobs: string;
    materials: string;
    activity: string;
    profile: string;
  };

  /** The persistent top bar and the profile drawer. Icon-only controls are
      labelled from here rather than hardcoded: every one of these is spoken
      aloud by a screen reader, and Capo speaks three languages. */
  shell: {
    openMenu: string;
    profile: string;
    search: string;
    searchUnavailable: string;
    voiceNote: string;
    newTask: string;
    close: string;
    role: string;
    version: (v: string) => string;
    rooms: {
      personal: { title: string; sub: string };
      team: { title: string; sub: string };
      billing: { title: string; sub: string };
      privacy: { title: string; sub: string };
      settings: { title: string; sub: string };
    };
    deleteAccount: {
      row: string;
      cannotUndo: string;
      title: string;
      body: string;
      placeholder: string;
      cancel: string;
      confirm: string;
      unavailable: string;
    };
  };
```

- [ ] **Step 2: Fill pt-PT**

```ts
  nav: {
    home: 'Início',
    chat: 'Chat',
    tasks: 'Tarefas',
    jobs: 'Obras',
    materials: 'Materiais',
    activity: 'Atividade',
    profile: 'Perfil',
  },

  shell: {
    openMenu: 'Abrir menu',
    profile: 'Perfil',
    search: 'Pesquisar',
    searchUnavailable: 'A pesquisa ainda não está disponível',
    voiceNote: 'Nota de voz',
    newTask: 'Nova tarefa',
    close: 'Fechar',
    role: 'Encarregado',
    version: (v: string) => `Capo ${v}`,
    rooms: {
      personal: { title: 'Informação pessoal', sub: 'Empresa, nome, email, telefone' },
      team: { title: 'Equipa', sub: 'Quem trabalha consigo' },
      billing: { title: 'Faturação', sub: 'Subscrição e pagamentos' },
      privacy: { title: 'Privacidade', sub: 'Memória, notificações, mensagens' },
      settings: { title: 'Definições', sub: 'Idioma, aspeto, conta' },
    },
    deleteAccount: {
      row: 'Apagar conta',
      cannotUndo: 'Não pode ser desfeito',
      title: 'Apagar esta conta',
      body: 'Todas as obras, tarefas, fotografias e mensagens são apagadas para toda a equipa. Isto não pode ser desfeito.',
      placeholder: 'Nome da empresa',
      cancel: 'Cancelar',
      confirm: 'Apagar para sempre',
      unavailable: 'Ainda não é possível apagar a conta a partir da aplicação. Fale connosco e tratamos disso.',
    },
  },
```

- [ ] **Step 3: Fill es-ES and en-US**

es-ES: `nav.home: 'Inicio'`, `nav.activity: 'Actividad'`. en-US: `nav.home: 'Home'`, `nav.activity: 'Activity'`. Translate the `shell` block to match — es-ES `rooms.billing.title: 'Facturación'`, en-US `'Billing'`; es-ES `deleteAccount.row: 'Eliminar cuenta'`, en-US `'Delete account'`, and so on for every key. **Do not leave any key in Portuguese in the other two files** — `tsc` will not catch a wrong-language string, only a missing one.

- [ ] **Step 4: Verify**

```bash
pnpm turbo typecheck
```

Expected: PASS. If a dictionary is missing a key, `tsc` fails **at that dictionary**, naming it — that is the whole reason `Catalog` is a type rather than a convention.

- [ ] **Step 5: Commit**

```bash
git add packages/i18n/src/catalog.ts packages/i18n/src/dictionaries/
git commit -m "feat(i18n): shell copy for the top bar, drawer and five rooms

nav gains home and activity; a new shell block carries every icon-only
control's label, the five room titles and the delete-account copy. Typed on
Catalog so a dictionary that falls behind is a tsc error at that dictionary
rather than an empty label found on a phone.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Split `/perfil` into five rooms

**The riskiest task in Round 1, scheduled early on purpose.** Twelve working cards move house, and they save language, WhatsApp consent, confirm posture and memory. A broken save here is silent.

Two commits, and the split is the safety mechanism: commit A is a **pure move** a reviewer can verify by reading a diff that only changes file paths; commit B is **styling only**. See "The UNCONVERTED ledger constrains Task 3" above for why the conversion is not optional.

**Files:**
- Create: `apps/web/app/(app)/perfil/pessoal/page.tsx`, `equipa/page.tsx`, `privacidade/page.tsx`, `definicoes/page.tsx`
- Modify: `apps/web/app/(app)/perfil/page.tsx:219-511` (becomes the five-row list)
- Modify: `scripts/design-check.mts:281` (delete the ledger entry)
- Unchanged: `perfil/actions.ts`, `profile-forms.tsx`, `push-card.tsx`, `sign-out-button.tsx`, `theme-pills.tsx`, `translation-progress.tsx` — all four rooms import from them as `/perfil/page.tsx` does today

**Interfaces:**
- Consumes: `Catalog['shell']['rooms']` from Task 2.
- Produces: four routes Task 6's drawer links to: `/perfil/pessoal`, `/perfil/equipa`, `/perfil/privacidade`, `/perfil/definicoes`. Billing is the **existing** `/subscricao` — do not create a route for it.

- [ ] **Step 1: Read the source before moving anything**

Read `apps/web/app/(app)/perfil/page.tsx` end to end. Note the card boundaries — `t.profile.company` (232), `t.profile.yourAccount` (236), `t.settings.whatsappConsent` (246), `t.settings.confirmPosture` (273), `t.settings.appearance` (280), `t.settings.language` (289), `t.profile.team` (379), `t.notifications.title` (462), `t.automations.title` (473), `t.memory.title` (486), `t.profile.subscription` (493), `t.profile.app` (508) — and which loader each depends on.

- [ ] **Step 2: Create the four rooms, moving card JSX verbatim**

Each room is an `async` server component following the existing page's shape: `requireAuthT()`, load only what its own cards need, wrap in `AppBar` + `PullToRefresh`. Use `AppBar` from `@/app/_ui/nav` with `backHref="/perfil"` and `backLabel={t.shell.close}` — a room is a drill-down and needs Back, so it does **not** use `TabScreen`.

Skeleton, identical in all four (`pessoal` shown; repeat the shape, not this exact body, for the others):

```tsx
import type { Metadata } from 'next';
import { AppBar } from '@/app/_ui/nav';
import { metadataTitle, requireAuthT } from '@/lib/i18n';
import PullToRefresh from '@/app/pull-to-refresh';
import { CompanyForm, AccountForm } from '../profile-forms';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: await metadataTitle(t => t.shell.rooms.personal.title) };
}

export default async function PessoalPage() {
  const { ctx, locale, t } = await requireAuthT();
  // ...load only what this room's cards need
  return (
    <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col overflow-hidden">
      <AppBar title={t.shell.rooms.personal.title} backHref="/perfil" backLabel={t.shell.close} />
      <PullToRefresh locale={locale}>
        {/* the moved cards, verbatim */}
      </PullToRefresh>
    </div>
  );
}
```

Card allocation, per spec §4.4:

| Room | Cards | Loaders needed |
|---|---|---|
| `pessoal` | company, yourAccount | `requireAuthT`, the profile/company reads and `claims` |
| `equipa` | team | `loadTeam`, `loadTeamLoad` |
| `privacidade` | memory, notifications, whatsappConsent | `vapidPublicKey`, `hasWhatsAppConsent` |
| `definicoes` | language, appearance, confirmPosture, automations, app | `countTranslatable`, `resolveTheme`, the translation batch read |

**Copy the local `Card` helper (`page.tsx:35-42`) into each room unchanged in this commit.** Commit B replaces it.

**`LanguageDriftNote` moves to `definicoes`, above the Language card, not inside any disclosure.** A manager who does not know the two language dials can disagree will never open a disclosure about it — that is the entire point of the note (issue #55).

The `guardado` / `erro` flash banners at `page.tsx:212-222` are read from search params by the server actions in `./actions.ts`. **Every room that hosts a form needs them**, or saving succeeds and says nothing. That is `pessoal`, `privacidade` and `definicoes`.

- [ ] **Step 3: Reduce `/perfil/page.tsx` to the five-row list**

```tsx
import type { Metadata } from 'next';
import { AppBar, ListRow } from '@/app/_ui/nav';
import { Card } from '@capo/ui/card';
import { metadataTitle, requireAuthT } from '@/lib/i18n';
import { getBillingState } from '@/lib/billing';
import SignOutButton from './sign-out-button';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: await metadataTitle(t => t.profile.title) };
}

// The same five rooms the drawer lists, as a plain page. Two doors to one
// place on purpose: the drawer is the phone-native shortcut, this is what a
// bookmark, a desktop-width browser and a deep link land on. Both lead to the
// identical routes, so neither can drift from the other.
export default async function PerfilPage() {
  const { ctx, locale, t } = await requireAuthT();
  const billing = await getBillingState(ctx);
  const rooms = [
    { href: '/perfil/pessoal', ...t.shell.rooms.personal },
    { href: '/perfil/equipa', ...t.shell.rooms.team },
    { href: '/subscricao', ...t.shell.rooms.billing },
    { href: '/perfil/privacidade', ...t.shell.rooms.privacy },
    { href: '/perfil/definicoes', ...t.shell.rooms.settings },
  ];
  return (
    <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col overflow-hidden">
      <AppBar title={t.profile.title} />
      <div className="flex-1 overflow-y-auto overscroll-contain p-4">
        <Card padding="none">
          {rooms.map(room => (
            <ListRow key={room.href} href={room.href} title={room.title} subtitle={room.sub} />
          ))}
        </Card>
        <SignOutButton locale={locale} />
      </div>
    </div>
  );
}
```

Check `ListRow`'s real prop names in `packages/ui/src/list-row.tsx` before writing this — `title`/`subtitle` are assumed here and must be confirmed. Same for `Card`'s `padding` prop.

- [ ] **Step 4: Verify the move compiles and nothing is orphaned**

```bash
pnpm turbo typecheck && pnpm turbo lint
```

Expected: PASS. `design-check` is expected to **FAIL** at this commit with four new dirty files — that is the point of splitting the commits, and the next step fixes it.

- [ ] **Step 5: Commit A — the move**

```bash
git add "apps/web/app/(app)/perfil/"
git commit -m "refactor(perfil): split twelve settings cards into five rooms, verbatim

Structure only. Every card's JSX, every form and every server action is
byte-identical to what it was inside perfil/page.tsx — this commit is meant
to be reviewable as a move, because these cards save language, WhatsApp
consent, confirm posture and memory, and a broken save here makes no noise.

Billing is the EXISTING /subscricao rather than a new room: that screen is
already complete with its own Stripe actions, so the old subscription card
collapses into the row's subtitle.

design-check is red at this commit — the ledger allows one dirty perfil file
and there are now five. The next commit converts them, which is what the
gate is for.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Commit B — convert the five files to the design system**

Delete the local `Card` helper from all five files. Use `Card` from `@capo/ui/card` and `ListRow` from `@/app/_ui/nav`. Replace, everywhere in these files:

| Raw | Token utility |
|---|---|
| `border-zinc-500/20`, `border-zinc-500/30` | `border-hairline` |
| `text-zinc-500` | `text-fg-muted` (body) or `text-fg-faint` (metadata) |
| `text-orange-600` | `text-brand` |
| `bg-emerald-500/10 text-emerald-700` | `<Banner tone="success">` |
| `bg-red-500/10 text-red-700` | `<Banner tone="danger">` |
| `text-xs` / `text-sm` | `text-caption` / `text-body` — confirm the real scale names in `tokens.css` |

Then delete line 281 of `scripts/design-check.mts`:

```
  'apps/web/app/(app)/perfil/page.tsx',
```

- [ ] **Step 7: Verify the gate is green**

```bash
pnpm turbo typecheck && pnpm turbo lint && pnpm design-check
```

Expected: all PASS. `design-check` must report the ledger one entry shorter and **no** stale-entry failure.

- [ ] **Step 8: Manual check — the no-JavaScript save path**

This is the single property most at risk in Round 1 and **nothing automated covers it.**

`pnpm dev`. In the browser devtools, disable JavaScript. Navigate to `/perfil/definicoes`. Change the language radio and submit. Confirm the page reloads and the language actually changed. Repeat on `/perfil/pessoal` (the name field) and `/perfil/privacidade` (the WhatsApp consent toggle).

If any of these fail, the cause is almost certainly that a card was wrapped in something that requires a client boundary. `SegmentedControl` is built on radio inputs precisely so a cold PWA on a bad site connection can save before any JavaScript has run — that property must survive this move.

- [ ] **Step 9: Commit B**

```bash
git add "apps/web/app/(app)/perfil/" scripts/design-check.mts
git commit -m "style(perfil): put the five rooms on the design system, shrink the ledger

Styling only — no form, action or loader changes. The local Card helper with
border-zinc-500/20 is gone from all five files in favour of @capo/ui's Card,
raw zinc and orange become fg/brand tokens, and the two flash banners become
Banner with tones.

Forced rather than chosen: design-check asserts stillDirty.size <=
UNCONVERTED.length, so splitting one dirty file into five failed the gate.
Converting instead means the ledger loses perfil/page.tsx outright.

Verified by hand with JavaScript disabled: language, name and WhatsApp
consent all still save. That path exists for a cold PWA on a bad site
connection and no gate in this repo can see it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `Obras | Materiais` switch

**Files:**
- Modify: `apps/web/app/(app)/obras/page.tsx` (whole file)
- Modify: `apps/web/app/(app)/materiais/page.tsx` (becomes a redirect; its body moves into a shared component)
- Create: `apps/web/app/(app)/obras/materials-view.tsx` — the materials body, lifted from `materiais/page.tsx:60-113`

**Interfaces:**
- Consumes: `Catalog['nav']['jobs']`, `Catalog['nav']['materials']` from Task 2.
- Produces: `/obras?vista=materiais`, the address Task 6's drawer does **not** link to but Round 2's Home widget will.

- [ ] **Step 1: Lift the materials body into a component**

Move everything inside `materiais/page.tsx`'s `<PullToRefresh>` — both `<section>` blocks and the `groupAction` / `itemAction` render props — into `obras/materials-view.tsx` as an `async` server component taking `ctx` and `t`. Change nothing inside it.

- [ ] **Step 2: Add the switch to `/obras`**

```tsx
export default async function ObrasPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { ctx, locale, t } = await requireAuthT();
  const raw = (await searchParams).vista;
  // Anything that is not exactly 'materiais' is the sites list. An unknown
  // value must land somewhere real rather than render an empty screen.
  const view = (Array.isArray(raw) ? raw[0] : raw) === 'materiais' ? 'materiais' : 'obras';
  // ...
}
```

Render the switch as links, not radios — this one navigates rather than saves, so `<a>` is the honest element and it works with no JavaScript by construction:

```tsx
<div role="tablist" className="mx-4 mt-3 grid grid-cols-2 gap-0.5 rounded-full bg-surface-sunken p-1">
  {(['obras', 'materiais'] as const).map(v => (
    <Link
      key={v}
      href={v === 'obras' ? '/obras' : '/obras?vista=materiais'}
      role="tab"
      aria-selected={view === v}
      className={`flex min-h-10 items-center justify-center rounded-full text-body no-underline transition-colors ease-out ${
        view === v ? 'bg-surface font-semibold text-fg shadow-float' : 'font-medium text-fg-muted'
      }`}
    >
      {v === 'obras' ? t.nav.jobs : t.nav.materials}
    </Link>
  ))}
</div>
```

`SegmentedControl` is deliberately **not** reused: it is a radio group built for saving a value, and its `value` prop sets the initial selection only (see its shouted file banner). A navigating switch is a different control that happens to look similar.

- [ ] **Step 3: Turn `/materiais` into a redirect**

```tsx
import { redirect } from 'next/navigation';

// Kept as a route rather than deleted: this address is in the wild — home
// screens, bookmarks, and any link Capo has written into a chat thread.
export default function MateriaisPage() {
  redirect('/obras?vista=materiais');
}
```

Delete `'apps/web/app/(app)/materiais/page.tsx'` from `UNCONVERTED` in `scripts/design-check.mts` — a three-line redirect violates nothing, so leaving it listed fails as stale.

- [ ] **Step 4: Verify**

```bash
pnpm turbo typecheck && pnpm turbo lint && pnpm design-check
```

Expected: all PASS, ledger one shorter again.

- [ ] **Step 5: Manual check**

`pnpm dev`. Visit `/obras` — sites list, switch on the left. Tap Materiais — the tomorrow / this-week buy list, unchanged, switch on the right. Visit `/materiais` directly and confirm it lands on the materials view. Refresh on `/obras?vista=materiais` and confirm it stays there.

- [ ] **Step 6: Commit**

```bash
git add "apps/web/app/(app)/obras/" "apps/web/app/(app)/materiais/" scripts/design-check.mts
git commit -m "feat(obras): the buy list moves in behind a switch, not a link

Materiais leaves the tab bar and lands here rather than behind a link in the
scroller. Both cost one tap; they differ in discoverability, and the buy list
is consulted at the moment a manager is already thinking about something else
— so keeping the word visible on landing was worth more than the objection
that a switch implies a filtered view of the sites list.

The view is a URL param, so it is refresh-safe and bookmarkable, and it is
built from links rather than SegmentedControl: that component is a radio
group for saving a value, and this navigates.

/materiais stays as a redirect — that address is on home screens.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: `voice` and `compose` params on the chat

The top bar's microphone and `+` need real destinations. **Neither exists today** — `(app)/page.tsx` reads `?q=` and passes it to `Chat` as `initialInput`, and nothing focuses the composer.

**Files:**
- Modify: `apps/web/app/(app)/page.tsx:24-30` (the existing `rawQ` block)
- Modify: `apps/web/app/chat.tsx:220-240` (props and the composer)

**Interfaces:**
- Produces: `/?voice=1` arms the recorder on mount; `/?compose=1` focuses the composer. Task 6's top bar links to both.

- [ ] **Step 1: Read the params in the page**

```tsx
const sp = await searchParams;
const rawQ = sp.q;
const initialInput = (Array.isArray(rawQ) ? rawQ[0] : rawQ)?.slice(0, 500) ?? '';
// Presence, not value: these are triggers, not data. Anything truthy counts,
// so a link can say ?voice=1 without the page caring what "1" is.
const autoVoice = sp.voice !== undefined;
const autoFocus = sp.compose !== undefined;
```

Pass all three to `<Chat />`.

- [ ] **Step 2: Accept them in `chat.tsx`**

Add `autoVoice?: boolean` and `autoFocus?: boolean` to the props, both defaulting to `false`. `autoFocus` focuses the textarea ref in a mount effect. `autoVoice` starts the existing `MicButton` recording on mount.

**Read `mic-button.tsx` before wiring `autoVoice`.** It owns `MediaRecorder`, and starting a recording needs a microphone permission prompt, which browsers only grant from a user gesture in some configurations. If starting on mount is refused, the correct fallback is to render the recorder *focused and ready* rather than recording — a link that silently fails to record is worse than one that puts the button under the thumb. Take that fallback if the gesture requirement bites; do not fight it.

- [ ] **Step 3: Verify**

```bash
pnpm turbo typecheck && pnpm turbo lint && pnpm design-check
```

- [ ] **Step 4: Manual check**

`pnpm dev`. Visit `/?compose=1` — cursor in the composer. Visit `/?voice=1` — recorder armed, or focused if the permission gesture blocked it. Visit `/` — neither happens, exactly as today.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(app)/page.tsx" apps/web/app/chat.tsx
git commit -m "feat(chat): two params so the top bar's mic and + have somewhere to go

The recorder existed only as a control inside the composer and nothing
focused the composer, so both top-bar buttons had no destination. Presence
rather than value: ?voice=1 and ?compose=1 are triggers, so a caller does not
have to agree with the page about what '1' means.

The + goes to the chat rather than a form on purpose — telling Capo about a
job IS how a task gets made here (create_task), so this is the product, not
a workaround for a missing screen.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: The persistent top bar and profile drawer

Every route this links to now exists (Tasks 3 and 5).

**Files:**
- Create: `apps/web/app/_ui/top-bar.tsx`
- Create: `apps/web/app/_ui/profile-drawer.tsx`
- Modify: `apps/web/app/(app)/layout.tsx:70-105`

**Interfaces:**
- Consumes: `useOverlay({ open, onClose }): { mounted, panel }` (Task 1), `Catalog['shell']` (Task 2), the four `/perfil/*` routes (Task 3), `/?voice=1` and `/?compose=1` (Task 5).
- Produces:
  - `ProfileDrawer({ open, onClose, locale, name, company, initials })` — no `version` prop; the footer reads a module constant, because nothing in this build exposes a version string to the client.
  - `TopBar({ locale, name, company, initials })` — rendered once by the layout, owns the drawer's open state, forwards all four props straight through.

- [ ] **Step 1: Build the drawer**

```tsx
'use client';

import Link from 'next/link';
import { createPortal } from 'react-dom';
import { Card } from '@capo/ui/card';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import { ListRow } from '@/app/_ui/nav';
import SignOutButton from '@/app/(app)/perfil/sign-out-button';
import { useOverlay } from './use-overlay';

// Hand-maintained, because nothing in this build exposes a version string to
// the client and adding a build-time inject for one footer line is not worth
// it. Bump it when you would have told a manager "update the app".
const APP_VERSION = '2.4.1';

export function ProfileDrawer({
  open,
  onClose,
  locale,
  name,
  company,
  initials,
}: {
  open: boolean;
  onClose: () => void;
  locale: Locale;
  name: string;
  company: string;
  initials: string;
}) {
  const t = getCatalog(locale);
  const { mounted, panel } = useOverlay({ open, onClose });

  // Same server/client split as Sheet: createPortal reaches for document.body
  // and Next runs 'use client' render functions on the server to build the
  // initial HTML, where there is no document.
  if (!mounted) return null;

  const rooms = [
    { href: '/perfil/pessoal', ...t.shell.rooms.personal },
    { href: '/perfil/equipa', ...t.shell.rooms.team },
    { href: '/subscricao', ...t.shell.rooms.billing },
    { href: '/perfil/privacidade', ...t.shell.rooms.privacy },
    { href: '/perfil/definicoes', ...t.shell.rooms.settings },
  ];

  return createPortal(
    <>
      {/* Scrim. pointer-events-none when closed so a closed drawer cannot eat
          taps meant for the page — the failure is invisible and total. */}
      <div
        onClick={onClose}
        role="presentation"
        className={`fixed inset-0 z-40 bg-fg/40 transition-opacity ease-out ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={t.shell.profile}
        tabIndex={-1}
        className={`fixed inset-y-0 left-0 z-50 flex w-[330px] max-w-[85vw] flex-col border-r border-hairline bg-surface outline-none shadow-sheet motion-safe:transition-transform motion-safe:duration-(--duration-slow) motion-safe:ease-out ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex items-center gap-3 border-b border-hairline p-4 pt-[max(1rem,env(safe-area-inset-top))]">
          <span
            aria-hidden
            className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-brand-quiet text-body font-semibold text-brand"
          >
            {initials}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-title font-semibold text-fg">{name}</span>
            <span className="truncate text-caption text-fg-muted">
              {t.shell.role} · {company}
            </span>
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t.shell.close}
            className="ml-auto grid min-h-11 min-w-11 place-items-center rounded-control text-fg-muted"
          >
            <svg viewBox="0 0 24 24" aria-hidden className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto overscroll-contain p-4">
          <Card padding="none">
            {rooms.map(room => (
              <ListRow key={room.href} href={room.href} title={room.title} subtitle={room.sub} />
            ))}
          </Card>

          {/* Deliberately minimal — icon and label only. The full explanation
              lives on /instalar; a marketing block in a settings drawer is
              something a manager scrolls past every time. */}
          <Link
            href="/instalar"
            className="flex min-h-12 items-center justify-center rounded-card bg-brand-quiet text-body font-semibold text-brand no-underline"
          >
            {t.profile.install}
          </Link>

          <div className="mt-auto flex flex-col items-center gap-2">
            <SignOutButton locale={locale} />
            <span className="text-caption text-fg-faint">{t.shell.version(APP_VERSION)}</span>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
```

Note the drawer renders (translated off-screen) rather than unmounting when closed, unlike `Sheet` — that is what makes the slide animate in *and* out. `Sheet` returns `null` when closed and animates only on entry; do not "fix" one to match the other.

**Motion uses the tokens, never the handoff's `260ms cubic-bezier(0.32, 0.72, 0, 1)`.** `--duration-slow` is already 260ms, an arbitrary bezier breaks the app's one motion vocabulary, and `motion-safe:` means a manager who has asked their phone to reduce motion gets no slide at all.

Confirm `Card`'s `padding` prop and `ListRow`'s `title`/`subtitle` prop names against `packages/ui/src/card.tsx` and `list-row.tsx` before writing this — they are assumed here.

- [ ] **Step 2: Build the top bar**

`top-bar.tsx`, `'use client'`, owning `const [open, setOpen] = useState(false)`.

```tsx
// Renders only on the tab roots. Drill-down screens (/tarefas/[id],
// /obras/[id], /perfil/*) carry their own AppBar instead, because that bar
// holds Back and Back outranks the avatar there. Self-hiding rather than
// per-route opt-out: an opt-out is a rule someone eventually forgets, and the
// symptom is two stacked bars on one screen.
const TAB_ROOTS = ['/', '/tarefas', '/obras', '/notificacoes'];
const pathname = usePathname();
if (!TAB_ROOTS.includes(pathname)) return null;
```

Left group: burger (40×44, `aria-label={t.shell.openMenu}`) and the profile block (44px, `aria-label={t.shell.profile}`), both calling `setOpen(true)`. The avatar is 36px `bg-brand-quiet text-brand` with a 10px `bg-success-solid` presence dot ringed in `border-2 border-surface`.

Right group, all `min-h-11 min-w-11 rounded-control`:

```tsx
{/* Present but disabled, and that is the honest shape of "the icon is there,
    tapping does nothing" (Federico, 2026-08-24). A click handler that no-ops
    would still be announced to a screen reader as a working button. */}
<button type="button" disabled aria-label={t.shell.search} title={t.shell.searchUnavailable}
        className="grid place-items-center text-fg-faint">
  {/* magnifier */}
</button>
<Link href="/?voice=1" aria-label={t.shell.voiceNote} className="grid place-items-center text-fg-muted">…</Link>
<Link href="/?compose=1" aria-label={t.shell.newTask}
      className="ml-0.5 grid place-items-center bg-brand text-on-brand">…</Link>
```

The `+` is the only solid brand fill in the bar. Do not add a second.

- [ ] **Step 3: Render it from the layout**

In `(app)/layout.tsx`, above `<BillingBanner>`:

```tsx
{state.status === 'ok' && (
  <TopBar
    locale={locale}
    name={state.ctx.fullName ?? ''}
    company={state.ctx.companyName ?? ''}
    initials={initialsOf(state.ctx.fullName)}
  />
)}
```

Check what `getAuthState` actually returns before writing this — if `fullName` / `companyName` are not on `ctx`, read them where `BillingBanner`'s data is read and pass them down. **Do not add a query.** If the name is genuinely not loaded anywhere in the layout today, render the avatar with no name lines rather than fetching; a second profile read on every page load is not worth two lines of text, and Round 2's greeting will need the name loaded properly anyway.

**It must be a sibling of the banner strips, never a child of the content column** — that column is `overflow-hidden` and would clip the drawer.

- [ ] **Step 4: Verify**

```bash
pnpm turbo typecheck && pnpm turbo lint && pnpm design-check && pnpm turbo build
```

- [ ] **Step 5: Manual check — five things, none of them automated**

1. The bar appears on `/`, `/tarefas`, `/obras`, `/notificacoes` and **not** on `/tarefas/<id>` or `/perfil/pessoal`.
2. Burger and profile block both open the drawer; scrim tap, X and Escape all close it.
3. Tab from inside the drawer cycles inside it and never reaches the page behind.
4. Closing returns focus to the control that opened it.
5. At 320px width the drawer still fits and the bar does not overflow — use devtools' narrowest phone preset.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/_ui/top-bar.tsx apps/web/app/_ui/profile-drawer.tsx "apps/web/app/(app)/layout.tsx"
git commit -m "feat(shell): a persistent top bar, and a drawer into the five rooms

The bar carries the manager's own name and the three things they do most.
It self-hides on drill-down routes rather than being opted out per screen —
an opt-out is a rule someone forgets, and the symptom is two stacked bars.

Both new overlays share Task 1's hook, so the drawer gets Sheet's focus trap,
escape and scroll lock rather than a second copy of them.

Search ships disabled rather than as a no-op handler: there is no search in
Capo at all, and a button that reports itself as working to a screen reader
while doing nothing is the one version of 'the icon is just there' we cannot
ship. Motion uses --duration-slow and ease-out, not the prototype's raw
bezier — the handoff's own README says to prefer the codebase's tokens.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: Four tabs, and tab screens lose their own bar

Must come after Task 6 — this removes the per-screen `AppBar` from the tab roots, and without the persistent bar already in place they would have no header at all.

**Files:**
- Modify: `apps/web/app/_ui/tab-bar.tsx:28-120` (the `TABS` array and `grid-cols-5`)
- Create: `apps/web/app/_ui/tab-screen.tsx`
- Modify: `apps/web/app/(app)/tarefas/page.tsx`, `obras/page.tsx`, `notificacoes/page.tsx`, and `(app)/page.tsx` if it renders a title

**Interfaces:**
- Consumes: `Catalog['nav']` (Task 2), `TopBar` (Task 6).
- Produces: `<TabScreen title subtitle>` — `ScreenShell`'s column without `AppBar`.

- [ ] **Step 1: Create `TabScreen`**

```tsx
// ScreenShell without the AppBar. On a tab root the persistent top bar is
// already the header, so a second bar would stack; the screen's own title
// moves into the scroller as a heading — which is what the Home launchpad
// does with its greeting in Round 2.
//
// ScreenShell stays exactly as it is, for drill-down screens that need Back.
export function TabScreen({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col overflow-hidden">
      <div className="px-4 pt-4">
        <h1 className="text-display font-semibold tracking-tight text-fg">{title}</h1>
        {subtitle && <p className="text-caption text-fg-muted">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}
```

Confirm `text-display` exists in `tokens.css` before using it; if not, use the nearest real scale name.

- [ ] **Step 2: Rewrite `TABS` — four entries, new order**

Order: Chat (`/`), Tarefas (`/tarefas`), Obras (`/obras`), Atividade (`/notificacoes`). Delete the Materiais and Perfil entries. Keep both icons per tab — that is an accessibility requirement, not a flourish: the bar signals the active tab by colour and by filled shape, because roughly one man in twelve has a colour-vision deficiency and construction is a heavily male trade.

Atividade reuses the existing Perfil-slot position with a pulse-line icon:

```tsx
{
  href: '/notificacoes',
  key: 'activity',
  outline: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  filled: <path d="M3 12h4l3-8 4 16 3-8h4" strokeWidth="2.6" />,
},
```

Change `grid-cols-5` to `grid-cols-4` in the `<nav>` className.

**Leave a comment recording why it is four**: Home does not exist until Round 2, and a Home tab pointing at `/` beside a Chat tab pointing at `/` gives two tabs one destination, both lit by the prefix-match rule below them.

**Do not remove `NotificationsStrip` from `(app)/layout.tsx`.** It is tempting now that Atividade has a tab — its own comment says it exists because all five slots were taken — and it is wrong until Round 3. The strip's job is to make an unread decision *unmissable*, and a tab label is not a count. It retires the day that tab carries a badge, not the day it exists.

- [ ] **Step 3: Swap the tab roots onto `TabScreen`**

In `tarefas/page.tsx`, `obras/page.tsx` and `notificacoes/page.tsx`, replace `ScreenShell` with `TabScreen`. Import stays from `@/app/_ui/tab-screen`, not `@capo/ui`.

- [ ] **Step 4: Verify**

```bash
pnpm turbo typecheck && pnpm turbo lint && pnpm design-check && pnpm turbo build
```

- [ ] **Step 5: Manual check**

Four tabs, correct labels in all three languages (switch on `/perfil/definicoes` and check each). Exactly one bar on every tab root. `/tarefas/<id>` still has its own `AppBar` with a working Back. Labels do not wrap at 320px.

- [ ] **Step 6: Commit**

```bash
git add apps/web/app/_ui/tab-bar.tsx apps/web/app/_ui/tab-screen.tsx "apps/web/app/(app)/"
git commit -m "feat(nav): four tabs, and one bar per screen instead of two

Chat · Tarefas · Obras · Atividade. Materiais and Perfil leave the bar and
both land somewhere better — a switch on Obras and the new drawer. Four
rather than five deliberately: Home does not exist until Round 2, and a Home
tab beside a Chat tab both pointing at / would light two tabs for one
destination under the prefix-match rule.

Atividade points at /notificacoes for now. Not a placeholder — it is the
closest real surface, it keeps its unread count, and Round 3 widens it into
the full site feed rather than replacing it.

Tab roots move to TabScreen so their title renders in the scroller instead
of a second AppBar under the persistent one. ScreenShell is untouched and
still serves every drill-down screen that needs Back.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: The delete-account row and its inert sheet

**Files:**
- Create: `apps/web/app/(app)/perfil/definicoes/delete-account-sheet.tsx`
- Modify: `apps/web/app/(app)/perfil/definicoes/page.tsx` (append the row)

**Interfaces:**
- Consumes: `Sheet` (Task 1), `Catalog['shell']['deleteAccount']` (Task 2), the `definicoes` route (Task 3).
- Produces: nothing later tasks use.

- [ ] **Step 1: Build the sheet**

```tsx
'use client';

import { useState } from 'react';
import { Sheet } from '@/app/_ui/sheet';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';

// The typed-confirmation gate is BUILT and wired to nothing.
//
// Federico's decision (2026-08-24) was "add the button, don't create the
// route yet". The confirm button is therefore permanently disabled and says
// why, rather than arming itself when the company name matches and then doing
// nothing — a manager who typed their company name, tapped a red button
// labelled "delete forever" and got silence would reasonably believe their
// account was gone.
//
// `matches` is computed and deliberately unused for now: it is what a future
// round enables by deleting one `|| true`. Capo has no account deletion at
// all today (the schema has exactly one DELETE policy in total), and EU data
// protection law's right to erasure means that gap has to close eventually.
export function DeleteAccountSheet({ locale, companyName }: { locale: Locale; companyName: string }) {
  const t = getCatalog(locale).shell.deleteAccount;
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const matches = typed.trim().toLowerCase() === companyName.trim().toLowerCase();

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-14 w-full items-center justify-between rounded-card bg-danger-quiet px-4 text-body font-semibold text-danger"
      >
        {t.row}
        <span className="text-caption font-medium opacity-85">{t.cannotUndo}</span>
      </button>

      <Sheet open={open} onClose={() => { setOpen(false); setTyped(''); }} title={t.title}>
        <h2 className="text-title font-semibold text-danger">{t.title}</h2>
        <p className="mt-2 text-body text-fg-muted">{t.body}</p>
        <p className="mt-2 text-caption text-fg-faint">{t.unavailable}</p>
        <input
          value={typed}
          onChange={e => setTyped(e.target.value)}
          placeholder={t.placeholder}
          aria-label={t.placeholder}
          // 16px minimum, or iOS zooms the whole page when it is focused.
          className="mt-3 min-h-12 w-full rounded-control border border-border-control bg-surface-sunken px-3.5 text-base"
        />
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button type="button" onClick={() => setOpen(false)}
                  className="min-h-11 rounded-full bg-surface-sunken text-body font-semibold text-fg">
            {t.cancel}
          </button>
          <button type="button" disabled
                  className="min-h-11 rounded-full bg-danger-solid text-body font-semibold text-on-solid opacity-45">
            {t.confirm}
          </button>
        </div>
      </Sheet>
    </>
  );
}
```

If `matches` being unused trips the lint rule for unused variables, prefix it `void matches;` with the comment above rather than deleting it — the computation is the documentation of what a later round enables.

- [ ] **Step 2: Add the row to `definicoes`**

Last element in the scroller, below the app-version card, with clear separation.

- [ ] **Step 3: Verify**

```bash
pnpm turbo typecheck && pnpm turbo lint && pnpm design-check
```

Confirm `border-border-control`, `bg-danger-solid`, `text-on-solid` and `rounded-card` are all real utilities in `tokens.css`. Solid status fills are their own tokens and are identical in both themes on purpose — a delete confirmation is a fixed signal colour, not a themed surface, and white on the *themed* dark `--danger` fails contrast badly.

- [ ] **Step 4: Manual check**

Row appears at the bottom of `/perfil/definicoes`. It opens the sheet. Typing the company name exactly does **not** enable the red button. Escape and Cancel both close it, and reopening shows an empty field.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(app)/perfil/definicoes/"
git commit -m "feat(perfil): the delete-account row, with the deletion deliberately absent

Ships the row and the sheet; ships no deletion. The confirm button is
permanently disabled and the sheet says so in a plain line, rather than
arming itself on a correct company name and then doing nothing — that
version would leave a manager believing their account was gone.

The typed gate is built and wired to nothing on purpose, so a later round
enables it rather than designing it. Capo has no account deletion anywhere:
the schema has exactly one DELETE policy in total (push_subscriptions), by
design, and EU right-to-erasure means this gap has to close eventually. It
is named here rather than left implied.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: Gallery cases and the AGENTS.md correction

The last task, and the one most likely to be skipped. `AGENTS.md` currently asserts something this PR makes false, and a stale invariant in that file is worse than no invariant — every future session reads it as ground truth.

**Files:**
- Modify: `apps/web/app/design-system/screens/` (add cases)
- Modify: `AGENTS.md` (the language-dials paragraph and the tab-bar rationale)

**Interfaces:** none.

- [ ] **Step 1: Add the four hard layout cases to the gallery**

The gallery is dev-only and needs no login. Add: the top bar with a very long company name (truncation), the drawer open at 320px, the drawer's five rows, and the delete sheet with its inert button. These are the cases that break and that no screenshot in the handoff covers.

- [ ] **Step 2: Correct `AGENTS.md`**

Find: *"Both dials live on **`/perfil`** (there is no `/definicoes` route)"*. Replace with a statement that both dials, plus appearance and confirm posture, now live on `/perfil/definicoes`, reached from the drawer or from `/perfil`; that `LanguageDriftNote` sits above the control that fixes the drift and not inside the advanced disclosure; and that `/perfil` itself is now a five-row index rather than a settings screen.

Also update the `tab-bar.tsx` rationale paragraph — it explains a five-tab bar containing Materiais and Perfil, and that bar no longer exists. Record where each went and why, so the next session does not "restore" them.

- [ ] **Step 3: Full gate**

```bash
pnpm turbo lint typecheck build && pnpm design-check && pnpm scheduler-check
```

Expected: all PASS. Run `build` alone if another worktree is building — only one `next build` per workspace root.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md apps/web/app/design-system/
git commit -m "docs(agents): the settings route this PR created, and the tab bar it replaced

AGENTS.md asserted there is no /definicoes route and described a five-tab bar
holding Materiais and Perfil. Both are now false, and a stale invariant in
that file is worse than none — every session reads it as ground truth and
would 'restore' the tabs.

Gallery gains the four cases the handoff's screenshots do not cover: a long
company name in the bar, the drawer at 320px, its five rows, and the delete
sheet's inert button.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Definition of done for Round 1

- [ ] `pnpm turbo lint typecheck build` green
- [ ] `pnpm design-check` green, ledger **two** entries shorter (`perfil/page.tsx`, `materiais/page.tsx`)
- [ ] `pnpm scheduler-check` green (unaffected, but it is the merge gate)
- [ ] Language, name and WhatsApp consent all save **with JavaScript disabled**
- [ ] Exactly one bar on every screen
- [ ] Drawer: escape, scrim tap, X all close; focus trapped; focus handed back
- [ ] Four tabs correct in pt-PT, es-ES and en-US
- [ ] Nothing under `apps/web/app/api/`, `packages/core` or `supabase/migrations` changed

## Explicitly out of scope

Home launchpad (Round 2), Activity feed (Round 3), account deletion (Round 4), search, Team invites, roles and permissions. If any of these seems necessary to finish a task, the task has been misread — stop and re-read the spec's §3.
