// The four @capo/ui components that render a link, with next/link already
// bound to them.
//
// WHY THIS FILE EXISTS. @capo/ui is shared with apps/operator and must not
// depend on a router, so ListRow, ButtonLink, Banner and AppBar all default to
// a plain <a>. A plain <a> is a full document load: the App Router does not
// intercept one. Inside this app that means every tap tears down and rebuilds
// the shell and re-runs (app)/layout.tsx's auth, billing and unread-count
// queries — and design-check, tsc and next build all stay green while it
// happens. The only symptom is that the app quietly stops feeling like an app.
//
// Passing linkAs={Link} at each of the ~34 call sites would work and would be
// forgotten once, silently. Importing from here instead makes the correct
// thing the default and the names identical, so a screen only ever changes its
// import path.
//
// RULE: inside apps/web, import these four from '@/app/_ui/nav', never from
// '@capo/ui/...' directly. Non-navigational components (Card, Badge, Field,
// EmptyState, Skeleton, Button) have no link in them and are imported from
// @capo/ui as normal.
//
// No 'use client': next/link works from a server component, and every one of
// these four is server-rendered.
import type { ComponentProps } from 'react';
import Link from 'next/link';
import { AppBar as BaseAppBar } from '@capo/ui/app-bar';
import { Banner as BaseBanner } from '@capo/ui/banner';
import { ButtonLink as BaseButtonLink } from '@capo/ui/button';
import { ListRow as BaseListRow } from '@capo/ui/list-row';

// Distributive on purpose. AppBar's props are a UNION — backHref and
// backLabel travel together or not at all, enforced by the compiler — and a
// bare Omit<union, K> collapses it into one object type, silently losing that
// pairing. `T extends unknown ?` maps over each branch instead and keeps it.
type Without<T> = T extends unknown ? Omit<T, 'linkAs'> : never;

export function ListRow(props: Without<ComponentProps<typeof BaseListRow>>) {
  return <BaseListRow {...props} linkAs={Link} />;
}

export function ButtonLink(props: Without<ComponentProps<typeof BaseButtonLink>>) {
  return <BaseButtonLink {...props} linkAs={Link} />;
}

export function Banner(props: Without<ComponentProps<typeof BaseBanner>>) {
  return <BaseBanner {...props} linkAs={Link} />;
}

export function AppBar(props: Without<ComponentProps<typeof BaseAppBar>>) {
  return <BaseAppBar {...props} linkAs={Link} />;
}
