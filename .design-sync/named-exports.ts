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
export { default as BottomNav } from '../apps/web/app/bottom-nav';
export { default as MicButton } from '../apps/web/app/mic-button';
export { default as PullToRefresh } from '../apps/web/app/pull-to-refresh';
export { default as FilterChips } from '../apps/web/app/(app)/tarefas/filter-chips';
export { default as FilterControls } from '../apps/web/app/(app)/tarefas/filter-controls';
export { default as PushCard } from '../apps/web/app/(app)/perfil/push-card';
export { default as PasswordField } from '../apps/web/app/(public)/password-field';
export { default as InstallGuide } from '../apps/web/app/(public)/instalar/install-guide';
export { LanguageDriftNote, LanguageDriftStrip } from '../apps/web/app/(app)/language-drift';
export { TranslationProgress } from '../apps/web/app/(app)/perfil/translation-progress';
