import { EmptyState, Button, Card } from '@capo/ui';

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

const Clipboard = () => (
  <svg {...stroke} className="h-8 w-8">
    <path d="M9 4h6v3H9zM9 5.5H7a1 1 0 00-1 1V20a1 1 0 001 1h10a1 1 0 001-1V6.5a1 1 0 00-1-1h-2" />
    <path d="M9 13l2 2 4-4" />
  </svg>
);


/** The canonical empty screen, ported from the repo's own design-system
 *  gallery: a title that names the state, a body that says what will fill it,
 *  and the ONE thing worth doing next. */
export function WithAction() {
  return (
    <EmptyState
      title="Nada para hoje"
      body="Quando criares tarefas com data de hoje, aparecem aqui."
      action={<Button size="sm">Criar tarefa</Button>}
    />
  );
}

/** Title only. Legitimate where the screen itself already explains the
 *  context and there is genuinely nothing to offer. */
export function TitleOnly() {
  return <EmptyState title="Nenhum material registado." />;
}

/** With an icon. The icon is decorative — the title still carries the meaning,
 *  which is why it is not optional and the icon is. */
export function WithIcon() {
  return (
    <EmptyState
      icon={<Clipboard />}
      title="Sem tarefas atrasadas"
      body="Toda a equipa está em dia."
    />
  );
}

/** Where it actually appears: inside a Card with padding="none", which is how
 *  the gallery composes it — the EmptyState brings its own generous padding. */
export function InsideACard() {
  return (
    <Card padding="none">
      <EmptyState
        title="Ainda não há obras registadas"
        body="Fala com o Capo e ele cria a primeira por ti."
        action={<Button size="sm">Falar com o Capo</Button>}
      />
    </Card>
  );
}
