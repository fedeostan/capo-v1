import { IconButton } from '@capo/ui';

// Icons in this design system are inline SVG — 24 viewBox, currentColor
// stroke, width 2, round caps — so they inherit the button's variant colour.
// See the chevrons inside ListRow and AppBar for the same shape.
const stroke = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  className: 'h-5 w-5',
  'aria-hidden': true,
};

const Close = () => <svg {...stroke}><path d="M18 6L6 18M6 6l12 12" /></svg>;
const Pencil = () => <svg {...stroke}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" /></svg>;
const Trash = () => <svg {...stroke}><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>;
const Plus = () => <svg {...stroke}><path d="M12 5v14M5 12h14" /></svg>;

/** `label` is REQUIRED, and that is a design decision enforced by the
 *  compiler: an unlabelled icon button is invisible to a screen reader, and
 *  making the label a required prop turns a code review somebody has to
 *  remember into a build failure they cannot miss. */
export function Variants() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
      <IconButton label="Fechar" icon={<Close />} />
      <IconButton label="Editar" icon={<Pencil />} variant="secondary" />
      <IconButton label="Nova tarefa" icon={<Plus />} variant="primary" />
      <IconButton label="Apagar" icon={<Trash />} variant="destructive" />
    </div>
  );
}

/** Square at every size: 44 / 48 / 56px. The icon stays 20px throughout — it
 *  is the TARGET that grows, not the glyph. */
export function Sizes() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5rem' }}>
      <IconButton label="Fechar (pequeno)" icon={<Close />} size="sm" variant="secondary" />
      <IconButton label="Fechar (médio)" icon={<Close />} size="md" variant="secondary" />
      <IconButton label="Fechar (grande)" icon={<Close />} size="lg" variant="secondary" />
    </div>
  );
}

/** In an AppBar's action slot, which is where most of them live. */
export function InAnAppBar() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
      <IconButton label="Voltar" icon={<Close />} variant="tertiary" />
      <span className="text-title font-semibold text-fg">Casa de Paco</span>
      <IconButton label="Editar obra" icon={<Pencil />} variant="tertiary" />
    </div>
  );
}
