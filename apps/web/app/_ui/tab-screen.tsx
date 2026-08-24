import type { ReactNode } from 'react';

// ScreenShell without the AppBar.
//
// On a tab root the persistent top bar IS the header, so a second bar under it
// would stack two headers on one screen. The screen's own title moves into the
// scroller as a heading instead — which is also what the Home launchpad does
// with its greeting in Round 2, so the two will match rather than diverge.
//
// ScreenShell stays exactly as it is and is still correct for every drill-down
// screen, because those need Back and Back belongs in a bar. This is not a
// replacement for it; it is the other half of a split that used to be one
// component doing both jobs.
//
// The column here is byte-identical to ScreenShell's (mx-auto, max-w-2xl,
// min-h-0, overflow-hidden) rather than reusing it, because ScreenShell's
// signature is deliberately frozen so no existing caller has to change.
// overflow-hidden is the backstop: a route that forgets its own scroller gets
// clipped content (a loud bug) rather than a tab bar pushed off screen (a
// silent one).
export function TabScreen({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col overflow-hidden">
      <div className="shrink-0 px-4 pt-4 pb-1">
        <h1 className="truncate text-title font-semibold text-fg">{title}</h1>
        {subtitle && <p className="truncate text-caption text-fg-muted">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}
