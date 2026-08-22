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

## 4. The styling idiom: Tailwind v4 utilities

Use these families — they are the whole visual vocabulary of the product:

| Purpose | Classes |
|---|---|
| Hairlines, borders | `border border-zinc-500/20`, `border-zinc-500/30` |
| Muted text, secondary lines | `text-zinc-500` |
| Subtle fills | `bg-zinc-500/5`, `bg-zinc-500/10`, `bg-zinc-500/15` |
| Task state — in progress | `bg-orange-600/10 text-orange-600` |
| Task state — awaiting the manager | `bg-violet-600/10 text-violet-600` |
| Task state — blocked | `bg-red-600/10 text-red-600` |
| Task state — done | `bg-emerald-700/10 text-emerald-700` |
| Task state — cancelled | `bg-zinc-500/10 text-zinc-500 line-through` |
| Overdue / error text | `text-red-600` |
| Needs-action banner | `bg-amber-500/10 text-amber-700 dark:text-amber-400` |
| Shape | `rounded-lg`, `rounded-xl` |
| Section heading | `text-xs font-semibold uppercase tracking-wide text-zinc-500` |
| Screen width | `mx-auto w-full max-w-2xl` — every Capo screen is capped here |

Two things about colour that are specific to this system:

- **Violet means "a decision to make", not "a problem".** A completion claim
  awaiting the manager is violet; red is reserved for blocked and overdue.
- **`pending` is deliberately invisible.** It is the state of almost every open
  task, so `StatusBadge` renders nothing for it unless you pass `showPending`.

**Type:** body text is `Arial, Helvetica, sans-serif`, set on `body`. `font-mono`
is Geist Mono and is used for code and identifiers. There is no `font-sans`
utility — do not reach for one.

**Background/foreground** come from the `--background` / `--foreground` custom
properties applied to `body`. There is **no `bg-background` or `text-foreground`
utility** — use the surface classes above, or `var(--background)` directly.

**Dark mode is CLASS-based, not a media query.** `dark:` fires under `.dark` on
the root element, and under `.system` when the OS prefers dark. A design that
assumes `prefers-color-scheme` alone will not follow the user's choice.

## 5. Where the truth lives

Read `_ds/<folder>/styles.css` and its imports before styling anything, and each
component's `<Name>.d.ts` (the real prop contract) and `<Name>.prompt.md`
(usage) before composing it. Those files beat this summary.
