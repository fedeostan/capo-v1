// Named re-exports for every component whose module exports it as `default`.
//
// WHY THIS FILE EXISTS
// The converter builds its bundle entry with `export * from "<path>"`, and
// `export *` does NOT carry a module's DEFAULT export. Ten of the eleven
// components below are `export default function …`, so without this shim they
// would be bundled and then invisible on window.Capo — the previews would all
// fail with "Element type is invalid" and the cause would not be obvious.
// Re-exporting each default under its own name is the whole job.
//
// SCOPE RULE — read before adding to this list.
// Only components that render with props alone belong here. Anything importing
// a `'use server'` action module (theme-pills, assignee-picker, the profile
// forms, the completion sheet) or server-request APIs (language-switch calls
// cookies() at module top level) cannot render outside a live Next request and
// must NOT be added — see .design-sync/NOTES.md.

// MUST be first: it installs the `process` stand-in that next/link and
// next/navigation read at module scope. Import order is evaluation order,
// so moving this below any line that pulls in Next breaks the whole bundle.
import './process-shim';

// From packages/ui itself — markdown.tsx's only export is a default, so the
// converter's `export * from` entry misses it exactly like the app files below.
export { default as Markdown } from '../packages/ui/src/markdown';

// From apps/web.
export { default as MicButton } from '../apps/web/app/mic-button';
export { default as PullToRefresh } from '../apps/web/app/pull-to-refresh';
export { default as FilterChips } from '../apps/web/app/(app)/tarefas/filter-chips';
export { default as FilterControls } from '../apps/web/app/(app)/tarefas/filter-controls';
export { default as PushCard } from '../apps/web/app/(app)/perfil/push-card';
export { default as PasswordField } from '../apps/web/app/(public)/password-field';
export { default as InstallGuide } from '../apps/web/app/(public)/instalar/install-guide';
export { LanguageDriftNote, LanguageDriftStrip } from '../apps/web/app/(app)/language-drift';
export { TranslationProgress } from '../apps/web/app/(app)/perfil/translation-progress';

// ── Name collision: EmptyState ───────────────────────────────────────────────
// packages/ui exports TWO different components under this name:
//   src/dashboard-ui.tsx  — {text, cta}, still live on five screens
//   src/empty-state.tsx   — {icon, title, body, action}, THE design-system one
// A name exported by two STAR-EXPORTED modules is ambiguous, and esbuild drops
// it from the bundle entirely — so window.Capo.EmptyState was undefined and
// every card composing it rendered blank. An explicit re-export here does NOT
// beat that (verified with a minimal esbuild repro).
//
// The fix is in .design-sync/overrides/source-kit.mjs, which keeps
// dashboard-ui.tsx OUT of the synth entry. That makes THIS file the only
// provider of its exports, so every one of them must be listed below — an
// omission here silently removes a component from window.Capo.
export {
  ScreenShell,
  StatusBadge,
  TaskBoardList,
  ObrasList,
  TimelineList,
  MaterialsList,
  // Helpers that were already on window.Capo before the fork; listed so the
  // exclusion changes nothing except which EmptyState wins.
  riskReasons,
  formatShortDate,
} from '../packages/ui/src/dashboard-ui';

// The design-system EmptyState, now unambiguous.
export { EmptyState } from '../packages/ui/src/empty-state';

// ── apps/web/app/_ui — components that genuinely need the client ─────────────
// These live outside packages/ui (which is 'use client'-free by contract), so
// package.json's `exports` never names them and the synth entry cannot see
// them. They are NAMED exports rather than defaults, but they need this shim
// for the same reason the defaults above do: the entry only walks
// packages/ui/src.
export { Sheet } from '../apps/web/app/_ui/sheet';
export { SegmentedControl } from '../apps/web/app/_ui/segmented-control';
export { TabBar } from '../apps/web/app/_ui/tab-bar';
