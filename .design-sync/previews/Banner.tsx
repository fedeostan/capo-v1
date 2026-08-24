import { Banner } from '@capo/ui';

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

const Star = () => <svg {...stroke} className="h-4 w-4"><path d="M12 3l2.6 5.6 6 .8-4.4 4.2 1.1 6L12 16.8 6.7 19.6l1.1-6L3.4 9.4l6-.8z" /></svg>;
const Check = () => <svg {...stroke} className="h-4 w-4"><path d="M4 12l5 5L20 6" /></svg>;


/** The full-width shell strip. The five status tones use the `-solid` tokens,
 *  which are IDENTICAL in both light and dark: a danger banner is a fixed
 *  signal colour, not a themed surface, so its white label must not flip to
 *  near-black and vanish. */
export function Tones() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
      <Banner tone="danger" href="#">A tua subscrição expirou</Banner>
      <Banner tone="warn">Faltam 3 dias de teste</Banner>
      <Banner tone="info">2 notificações por ler</Banner>
      <Banner tone="success">Plano guardado</Banner>
    </div>
  );
}

/** `neutral` is the deliberate exception: it carries no signal colour, so it
 *  SHOULD follow the theme, and uses bg-fg/text-bg instead of a solid token. */
export function Neutral() {
  return <Banner tone="neutral">A obra está pausada</Banner>;
}

/** With an icon, and as a link — the whole strip becomes the tap target. */
export function Linked() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
      <Banner tone="brand" href="#" icon={<Star />}>
        Activar o plano completo
      </Banner>
      <Banner tone="review" href="#" icon={<Check />}>
        3 tarefas à espera da tua aprovação
      </Banner>
    </div>
  );
}
