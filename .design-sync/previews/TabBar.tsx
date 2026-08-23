import { TabBar } from '@capo/ui';

/** The five tabs, in Portuguese. The lit tab comes from the current route,
 *  and carries a FILLED icon as well as the brand colour — colour alone is
 *  not a signal roughly 1 man in 12 can read. */
export function Portuguese() {
  return <div style={{ maxWidth: 420 }}><TabBar locale="pt-PT" /></div>;
}

/** Spanish — the labels come from the same catalog, keyed on locale. */
export function Spanish() {
  return <div style={{ maxWidth: 420 }}><TabBar locale="es-ES" /></div>;
}

/** English. Five labels have to stay legible at 320px, which is what caps the tab count. */
export function English() {
  return <div style={{ maxWidth: 320 }}><TabBar locale="en-US" /></div>;
}
