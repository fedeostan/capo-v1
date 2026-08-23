import { BottomNav } from '@capo/ui';

/** The five tabs, in Portuguese. The lit tab comes from the current route. */
export function Portuguese() {
  return <div style={{ maxWidth: 420 }}><BottomNav locale="pt-PT" /></div>;
}

/** Spanish — the labels come from the same catalog, keyed on locale. */
export function Spanish() {
  return <div style={{ maxWidth: 420 }}><BottomNav locale="es-ES" /></div>;
}

/** English. Five labels have to stay legible at 320px, which is what caps the tab count. */
export function English() {
  return <div style={{ maxWidth: 320 }}><BottomNav locale="en-US" /></div>;
}
