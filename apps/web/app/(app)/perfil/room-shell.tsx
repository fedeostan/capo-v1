// The chrome every settings room shares.
//
// AppBar rather than TabScreen, and that is the whole reason this is not a tab
// screen: a room is a drill-down, so Back outranks anything else the header
// could carry. `backHref` is an explicit destination rather than router.back()
// — browser history can lead out of the app entirely, and a declared
// destination cannot — which also keeps this component free of JavaScript.
//
// It mirrors ScreenShell's column (mx-auto, max-w-2xl, overflow-hidden) rather
// than reusing it, because ScreenShell renders its own AppBar with no back
// link and its signature is deliberately frozen so no caller has to change.
import type { ReactNode } from 'react';
import { AppBar } from '@/app/_ui/nav';
import type { Locale } from '@capo/i18n/locale';
import PullToRefresh from '@/app/pull-to-refresh';

export function RoomShell({
  title,
  backLabel,
  locale,
  children,
}: {
  title: string;
  backLabel: string;
  locale: Locale;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col overflow-hidden">
      <AppBar title={title} backHref="/perfil" backLabel={backLabel} />
      <PullToRefresh locale={locale}>{children}</PullToRefresh>
    </div>
  );
}
