import { ListRow, Card, Badge } from '@capo/ui';

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

const Scaffold = () => <svg {...stroke} className="h-5 w-5 text-fg-faint"><path d="M4 4v16M20 4v16M4 9h16M4 15h16" /></svg>;
const Brush = () => <svg {...stroke} className="h-5 w-5 text-fg-faint"><path d="M4 20c0-2 1-3 3-3s3 1 3 3-1 2-3 2-3 0-3-2z" /><path d="M10 17L20 7l-3-3L7 14" /></svg>;


/** The WHOLE row is the tap target, never just the title — 56px minimum,
 *  which is what stops a row needing three attempts to hit on a moving van.
 *  `href` turns it into a link and adds the chevron. */
export function Linked() {
  return (
    <div style={{ maxWidth: 380 }}>
      <Card padding="none">
        <ListRow title="Pintar tecto" meta="Casa de Paco — a ajudar Miguel" href="#" />
        <ListRow title="Assentar azulejo" meta="Casa de Paco" href="#" />
      </Card>
    </div>
  );
}

/** `danger` turns the title red. For a row that is overdue or failing — not
 *  for a delete affordance. */
export function Danger() {
  return (
    <div style={{ maxWidth: 380 }}>
      <Card padding="none">
        <ListRow title="Assentar azulejo" meta="Atrasada 2 dias" danger href="#" />
      </Card>
    </div>
  );
}

/** Leading and trailing slots. Trailing is where a Badge goes; the chevron is
 *  added after it when the row is a link. */
export function WithSlots() {
  return (
    <div style={{ maxWidth: 380 }}>
      <Card padding="none">
        <ListRow
          leading={<Scaffold />}
          title="Montar andaime"
          meta="Vivenda do Zé"
          trailing={<Badge tone="warn">hoje</Badge>}
          href="#"
        />
        <ListRow
          leading={<Brush />}
          title="Pintar fachada"
          meta="Concluída ontem"
          trailing={<Badge tone="success">feita</Badge>}
          href="#"
        />
      </Card>
    </div>
  );
}

/** A long title truncates instead of forcing the row wider than the screen. */
export function Truncation() {
  return (
    <div style={{ maxWidth: 380 }}>
      <Card padding="none">
        <ListRow
          title="Um título muito comprido que não cabe de maneira nenhuma nesta linha estreita"
          meta="Truncation check"
          href="#"
        />
      </Card>
    </div>
  );
}

/** Without `href` the row is a plain div — no chevron, no link semantics. */
export function NotALink() {
  return (
    <div style={{ maxWidth: 380 }}>
      <Card padding="none">
        <ListRow title="Total de materiais" meta="Esta semana" trailing={<Badge>12</Badge>} />
      </Card>
    </div>
  );
}
