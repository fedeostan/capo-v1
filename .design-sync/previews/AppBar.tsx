import { AppBar, IconButton, Card, ListRow } from '@capo/ui';

// Inline SVG in the design system's own idiom — 24 viewBox, currentColor
// stroke, width 2, round caps — matching AppBar's own back chevron.
const Pencil = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    className="h-5 w-5"
    aria-hidden
  >
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" />
  </svg>
);

/** Sticky, translucent, blurred — so content is visibly passing underneath,
 *  which is a status cue rather than decoration. Blur is permitted in exactly
 *  two places in this design: here and behind a sheet. */
export function TitleOnly() {
  return (
    <div style={{ maxWidth: 400 }}>
      <AppBar title="Tarefas" />
    </div>
  );
}

/** With a subtitle — on a task screen this carries the obra and its address. */
export function WithSubtitle() {
  return (
    <div style={{ maxWidth: 400 }}>
      <AppBar title="Pintar tecto" subtitle="Casa de Paco · Rua das Flores 12" />
    </div>
  );
}

/** `backHref` is an explicit destination, never router.back(): browser history
 *  can lead out of the app entirely. It travels WITH `backLabel`, enforced by
 *  the compiler — Capo speaks three languages, so a hardcoded English "Back"
 *  would be announced on a Portuguese screen. */
export function WithBackAndAction() {
  return (
    <div style={{ maxWidth: 400 }}>
      <AppBar
        title="Casa de Paco"
        subtitle="12 tarefas · 3 atrasadas"
        backHref="#"
        backLabel="Voltar às obras"
        action={<IconButton label="Editar obra" icon={<Pencil />} />}
      />
    </div>
  );
}

/** Over a scrolling screen, which is the only place its stickiness and blur
 *  actually mean anything. */
export function OverContent() {
  return (
    <div style={{ maxWidth: 400, height: 260, overflowY: 'auto' }}>
      <AppBar title="Obras" subtitle="4 activas" />
      <div style={{ padding: '0.75rem' }}>
        <Card padding="none">
          <ListRow title="Casa de Paco" meta="12 tarefas · 3 atrasadas" href="#" />
          <ListRow title="Vivenda do Zé" meta="7 tarefas" href="#" />
          <ListRow title="Loja da Praça" meta="4 tarefas" href="#" />
          <ListRow title="Armazém Norte" meta="Pausada" href="#" />
        </Card>
      </div>
    </div>
  );
}
