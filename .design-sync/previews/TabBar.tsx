import { TabBar } from '@capo/ui';

/** EVERY TAB CARRIES TWO ICONS — outline and filled — and that is an
 *  accessibility requirement rather than a flourish. The bar it replaces
 *  signalled the active tab by COLOUR ALONE (orange versus grey). Roughly 1
 *  in 12 men has a colour-vision deficiency and construction is a heavily
 *  male trade, so that is a real share of the actual users. Colour plus a
 *  filled shape works with no colour perception at all.
 *
 *  The active tab comes from usePathname(), so in a preview it reflects the
 *  harness route rather than a prop. */
export function Portuguese() {
  return (
    <div style={{ maxWidth: 400 }}>
      <TabBar locale="pt-PT" />
    </div>
  );
}

/** The same five destinations in Spanish — labels come from the shared
 *  catalog, keyed off `locale`. */
export function Spanish() {
  return (
    <div style={{ maxWidth: 400 }}>
      <TabBar locale="es-ES" />
    </div>
  );
}

/** English, and deliberately the NARROWEST of the three at 320px. That width
 *  is the constraint the component's own source names: five labels have to
 *  stay legible there, and it is what caps the tab count at five. Verified in
 *  the shell batch — every tab 58x56px, no label overflowing. */
export function English() {
  return (
    <div style={{ maxWidth: 320 }}>
      <TabBar locale="en-US" />
    </div>
  );
}
