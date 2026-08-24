import { Card, ListRow, Badge } from '@capo/ui';

/** Depth level 1: a hairline border and NO shadow. Structure first — a shadow
 *  is for something that genuinely floats above something else. */
export function Padding() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxWidth: 380 }}>
      <Card padding="md">
        <p className="text-body text-fg">padding="md" — the default, for prose and forms.</p>
      </Card>
      <Card padding="sm">
        <p className="text-body text-fg">padding="sm" — tighter, for dense panels.</p>
      </Card>
    </div>
  );
}

/** padding="none" is what a card full of ListRows needs: the rows carry their
 *  own padding and must reach the card's edges, or every row is inset twice. */
export function HoldingRows() {
  return (
    <div style={{ maxWidth: 380 }}>
      <Card padding="none">
        <ListRow title="Pintar tecto" meta="Casa de Paco" href="#" />
        <ListRow title="Assentar azulejo" meta="Atrasada 2 dias" danger href="#" />
        <ListRow
          title="Montar andaime"
          meta="Vivenda do Zé"
          trailing={<Badge tone="review">review</Badge>}
          href="#"
        />
      </Card>
    </div>
  );
}
