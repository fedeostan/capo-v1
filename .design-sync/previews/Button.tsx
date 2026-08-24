import { Button } from '@capo/ui';

// Icons here are inline SVG in the design system's own idiom — 24 viewBox,
// currentColor stroke, width 2, round caps — so they inherit the surrounding
// text colour. See the chevrons inside ListRow and AppBar for the same shape.
const stroke = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

const Plus = () => <svg {...stroke} className="h-4 w-4"><path d="M12 5v14M5 12h14" /></svg>;
const Refresh = () => <svg {...stroke} className="h-4 w-4"><path d="M3 12a9 9 0 0115.5-6.2L21 8" /><path d="M21 3v5h-5" /></svg>;


/** THE RULE, shown rather than stated: at most one `primary` per screen.
 *  Ported from the repo's own design-system gallery. Three solid orange
 *  buttons would force the manager to read all three to find the one he
 *  wants; one means he does not read at all, he just taps. */
export function Variants() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
      <Button variant="primary">Guardar</Button>
      <Button variant="secondary">Cancelar</Button>
      <Button variant="tertiary">Editar</Button>
      <Button variant="destructive">Apagar</Button>
    </div>
  );
}

/** 44 / 48 / 56px. The design target is a man in work gloves on a building
 *  site, not a mouse pointer — 44px is the accessibility floor, not the aim. */
export function Sizes() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5rem' }}>
      <Button size="sm">Small 44px</Button>
      <Button size="md">Medium 48px</Button>
      <Button size="lg">Large 56px</Button>
    </div>
  );
}

/** `loading` keeps the label in the tree, hidden, so the button holds its
 *  exact width — swapping it for a spinner would shrink the button and move
 *  the page under the thumb that just tapped it. */
export function States() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
      <Button loading>Guardar</Button>
      <Button disabled>Guardar</Button>
      <Button variant="secondary" disabled>Cancelar</Button>
    </div>
  );
}

/** Full width is for the last control on a form and for sheet confirmations,
 *  where the button is the only thing left to do. */
export function FullWidth() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxWidth: 360 }}>
      <Button fullWidth>Guardar alterações</Button>
      <Button variant="tertiary" fullWidth>Cancelar</Button>
    </div>
  );
}

/** With a leading icon. The icon sits inside the label span, so it hides with
 *  the label while loading rather than floating beside the spinner. */
export function WithIcon() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
      <Button icon={<Plus />}>Nova tarefa</Button>
      <Button variant="secondary" icon={<Refresh />}>Actualizar</Button>
    </div>
  );
}
