// Mounts the Next.js App Router contexts that four of the synced components
// read from. Without it they do not merely look wrong — they throw:
//
//   BottomNav          usePathname() -> null, then null.startsWith(...)
//   PullToRefresh      useRouter()   -> "invariant expected app router to be mounted"
//   FilterControls     useRouter()   -> same
//   TranslationProgress useRouter()  -> same
//
// These are the REAL contexts Next exports, not stand-ins for next/link or
// next/navigation: the components below are the shipped ones, reading the
// context they actually read in the app. The router methods are inert because
// a preview card has nowhere to navigate to.
//
// Wired via `"provider": { "component": "NextPreviewProviders" }` in
// .design-sync/config.json. It wraps EVERY preview; the packages/ui components
// ignore it entirely.
import * as React from 'react';
// These paths are RELATIVE ON PURPOSE — do not "tidy" them into bare
// `next/...` specifiers. This file sits at the repo root, so a bare specifier
// makes Node walk UP out of the git worktree and resolve Next from the parent
// checkout's node_modules. That is a physically different copy of Next from the
// one the components bundle, so React.createContext runs twice and the provider
// sets a context the components never read: usePathname() returns null and
// useRouter() throws "invariant expected app router to be mounted" — with the
// provider visibly present and apparently correct.
import { AppRouterContext } from '../apps/web/node_modules/next/dist/shared/lib/app-router-context.shared-runtime';
import {
  PathnameContext,
  SearchParamsContext,
  PathParamsContext,
} from '../apps/web/node_modules/next/dist/shared/lib/hooks-client-context.shared-runtime';

// '/tarefas' rather than '/': BottomNav lights the tab whose href prefixes the
// current path, so a real route shows the active state instead of a dead nav.
const PATHNAME = '/tarefas';

const noop = () => {};
const router = {
  back: noop, forward: noop, refresh: noop,
  push: noop, replace: noop, prefetch: noop,
} as never;

export function NextPreviewProviders({ children }: { children: React.ReactNode }) {
  const search = React.useMemo(() => new URLSearchParams(), []);
  return (
    <AppRouterContext.Provider value={router}>
      <PathnameContext.Provider value={PATHNAME}>
        <SearchParamsContext.Provider value={search}>
          <PathParamsContext.Provider value={{}}>
            {children}
          </PathParamsContext.Provider>
        </SearchParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>
  );
}
