# Building with Capo

Capo is a mobile-first PWA for Portuguese construction managers: **obras**
(building sites), **tarefas** (tasks), crews, materials. Primary language is
**pt-PT**; es-ES and en-US are fully supported.

## 1. No provider. `locale` is a prop.

There is no React context anywhere in this library. Every component that
displays text takes `locale: 'pt-PT' | 'es-ES' | 'en-US'` and looks its copy up
itself. **Pass it explicitly to every component that accepts it** — omit it and
you get a type error, not a silent English fallback.

## 2. Screens are composed from three parts

```jsx
<div className="flex h-dvh flex-col">          {/* the app shell */}
  <PullToRefresh locale="pt-PT">               {/* THE scroller */}
    <ScreenShell title="Tarefas" subtitle="4 por fazer · 1 atrasada">
      <TaskBoardList locale="pt-PT" groupBy="date" today="2026-08-24"
        empty="Nada marcado para hoje." tasks={tasks} />
    </ScreenShell>
  </PullToRefresh>
  <BottomNav locale="pt-PT" />                 {/* sibling, outside the shell */}
</div>
```

Three rules that are easy to get wrong:

- **`ScreenShell` needs a flex column with height.** It is `flex-1 min-h-0`, so
  without one it collapses to zero height and renders blank.
- **`ScreenShell` carries no scroller and is `overflow-hidden`.** Content that
  overflows is clipped, silently. Put `PullToRefresh` (or your own
  `overflow-y-auto overscroll-contain`) around it.
- **`TaskDetail` does not render the task title.** The screen does:
  `<ScreenShell title={task.title} subtitle={[job.name, job.address].filter(Boolean).join(' · ')}>`.

## 3. Mutations arrive through render props

This library is presentational and owns no mutation. Every interactive control
is injected: `renderExtra`, `renderBelow`, `renderAssignee`,
`renderCollaborators`, `renderMaterials`, `renderActions`, `renderGroupAction`,
`renderItem`. Pass a node — never fork a component to add a button.

On `TaskDetail`, `renderCollaborators` and `renderMaterials` also make their
section render when the list is EMPTY, so the one screen that can add to them
never hides them.

## 4. Two generations of components. Prefer the newer one.

The library contains an older screen-level set and a newer primitive set. Both
ship and both work; **build new UI from the primitives below.**

| Use | Components |
|---|---|
| Actions | `Button`, `ButtonLink`, `IconButton` |
| Containers | `Card`, `ListRow`, `AppBar` |
| Forms | `Field` + `Input` / `Textarea` / `Select`, `SegmentedControl` |
| Status | `Badge`, `Banner` |
| Absence & waiting | `EmptyState`, `Skeleton` |
| Overlay & nav | `Sheet`, `TabBar` |
| Whole screens (older) | `ScreenShell`, `TaskBoardList`, `ObrasList`, `TimelineList`, `MaterialsList`, `TaskDetail` |

Four rules carried by these components:

- **At most one `primary` Button per screen.** Three solid orange buttons force
  the reader to compare all three; one means they just tap.
- **`Field` takes a render prop, not a child node:**
  `<Field id="x" label="Nome"> {a11y => <Input {...a11y} />} </Field>`. That is
  what makes the label/hint/error wiring impossible to forget.
- **`IconButton` requires `label`** — the compiler enforces it, because an
  unlabelled icon button is invisible to a screen reader.
- **`Card padding="none"` when it holds `ListRow`s** — the rows carry their own
  padding and must reach the card edges.

## 5. The styling idiom: Tailwind v4 utilities

**Only classes already present in the shipped stylesheet work** — there is no
Tailwind compiler at render time, so a class nobody in this library uses will
not exist. Prefer the token families below; they are the design system proper.

| Purpose | Classes |
|---|---|
| Page vs card | `bg-bg` (page), `bg-surface` (card), `bg-surface-sunken` (inputs) |
| Text | `text-fg`, `text-fg-muted`, `text-fg-faint` |
| Hairlines, control borders | `border-hairline`, `border-control` |
| Brand | `bg-brand`, `text-brand`, `text-on-brand`, `bg-brand-quiet` |
| Status text + quiet fill | `text-danger` / `text-warn` / `text-success` / `text-info` / `text-review`, each with `bg-*-quiet` |
| Status SOLID fills (banners) | `bg-danger-solid` … `bg-brand-solid`, always with `text-on-solid` |
| Type scale | `text-display` 32, `text-title` 22, `text-heading` 17, `text-body` 16, `text-callout` 15, `text-caption` 13, `text-micro` 11 |
| Shape | `rounded-card`, `rounded-control`, `rounded-chip`, `rounded-t-sheet` (Sheet only) |
| Screen width | `mx-auto w-full max-w-2xl` — every Capo screen is capped here |

Colour rules specific to this system:

- **`--brand` (`#c2410c`) is the only orange legal behind text.**
  `--brand-vivid` is 3.56:1 and is for large non-text fills only.
- **Violet means "a decision to make", not "a problem".** A completion claim
  awaiting the manager is `review`; `danger` owns "wrong".
- **Solid status fills are identical in both themes**, so their label must be
  `text-on-solid`. Never put banner text over the themed `text-danger`/`-info`.
- **`pending` is deliberately invisible.** `StatusBadge` renders nothing for it
  unless you pass `showPending`.
- **`text-*` is the COLOUR namespace here and also Tailwind's font-size
  namespace.** That is why muted text is `text-fg-muted`, never `text-muted`.

**Type:** body is Geist via `var(--font-sans)`, set on `body`. `font-mono` is
Geist Mono. There is no `font-sans` utility in the shipped CSS — body already
inherits it, so you never need one.

**`bg-background` exists and means `--surface` (a card), NOT the page.** For the
page use `bg-bg`. This trips people because the name suggests otherwise.

**Dark mode is CLASS-based, not a media query.** `dark:` fires under `.dark` on
the root element, and under `.system` when the OS prefers dark. A design that
assumes `prefers-color-scheme` alone will not follow the user's choice.

## 6. Where the truth lives

Read `_ds/<folder>/styles.css` and its imports before styling anything, and each
component's `<Name>.d.ts` (the real prop contract) and `<Name>.prompt.md`
(usage) before composing it. Those files beat this summary.
