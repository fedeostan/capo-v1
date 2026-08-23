// How a navigational component in this package renders its link.
//
// @capo/ui is shared with apps/operator and must NOT depend on a router, so
// every link in here defaults to a plain <a>. That default is a FULL PAGE
// LOAD. The App Router does not intercept a plain anchor — a same-origin href
// does not make it behave like next/link, whatever the old comment on
// ButtonLink claimed. In apps/web a full load tears down and rebuilds the
// whole shell on every tap, re-running the layout's auth, billing and
// unread-count queries, and NOTHING in the build would notice: design-check,
// tsc and next build all pass. It would just quietly feel worse.
//
// So apps/web passes `linkAs={Link}` — through apps/web/app/_ui/nav.tsx,
// which pre-binds it so a screen cannot forget — and gets client-side
// navigation back, while this package still never imports next/link.
//
// The type is ordinary anchor markup with `href` narrowed to a required
// string. Both `'a'` and next/link satisfy it. Do not widen it to something
// only next/link has: this package has to keep rendering in apps/operator.
import type { ComponentProps, ComponentType } from 'react';

export type LinkAsProps = Omit<ComponentProps<'a'>, 'href'> & { href: string };

export type LinkComponent = 'a' | ComponentType<LinkAsProps>;
