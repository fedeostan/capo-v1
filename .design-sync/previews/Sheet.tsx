import { Sheet, Button, ListRow, Card } from '@capo/ui';

/** The sheet renders through a PORTAL onto document.body with `fixed
 *  inset-0`, so it is drawn over the whole card rather than inside a box.
 *  Page content is composed behind it deliberately: it is what the component
 *  actually looks like in use, and without it the preview root would be
 *  literally empty while the screenshot looked fine. */
export function OpenOverAScreen() {
  return (
    <div style={{ minHeight: 480 }}>
      <Card padding="none">
        <ListRow title="Pintar tecto" meta="Casa de Paco" href="#" />
        <ListRow title="Assentar azulejo" meta="Casa de Paco" href="#" />
        <ListRow title="Montar andaime" meta="Vivenda do Zé" href="#" />
      </Card>
      <Sheet open onClose={() => {}} title="Concluir tarefa">
        <h2 className="text-heading font-semibold text-fg">Concluir tarefa</h2>
        <p className="pt-1 text-callout text-fg-muted">
          Pintar tecto — Casa de Paco
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', paddingTop: '1rem' }}>
          <Button fullWidth>Concluir com foto</Button>
          <Button variant="secondary" fullWidth>Concluir sem foto</Button>
          <Button variant="tertiary" fullWidth>Cancelar</Button>
        </div>
      </Sheet>
    </div>
  );
}
