import { ScreenShell, EmptyState, StatusBadge } from '@capo/ui';

// ScreenShell is `flex-1 min-h-0`, so it only has height inside a flex column
// that has one. In the app that column is <body class="flex h-dvh flex-col">;
// a preview that drops it renders a zero-height card, which is exactly how the
// unauthored floor card for this component came up blank.
const Screen = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: 'flex', flexDirection: 'column', height: 360, border: '1px solid rgba(113,113,122,0.2)', borderRadius: 12, overflow: 'hidden' }}>
    {children}
  </div>
);

/** Title and subtitle — the frame every Capo screen sits in. */
export function WithSubtitle() {
  return (
    <Screen>
      <ScreenShell title="Tarefas" subtitle="4 por fazer · 1 atrasada">
        <div style={{ padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 14 }}>Assentar azulejos</span>
            <StatusBadge status="in_progress" locale="pt-PT" />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 14 }}>Pintar tecto do quarto</span>
            <StatusBadge status="pending_review" locale="pt-PT" />
          </div>
        </div>
      </ScreenShell>
    </Screen>
  );
}

/** Title only — the subtitle is optional and the header stays one line. */
export function TitleOnly() {
  return (
    <Screen>
      <ScreenShell title="Materiais">
        <div style={{ padding: '0.75rem', fontSize: 14, color: '#71717a' }}>
          Tinta branca 15L · Cola de azulejo · Rodapé 8cm
        </div>
      </ScreenShell>
    </Screen>
  );
}

/** Wrapping an empty screen — the pairing the lists fall back to. */
export function AroundAnEmptyScreen() {
  return (
    <Screen>
      <ScreenShell title="Obras" subtitle="Nenhuma obra activa">
        <EmptyState text="Ainda não há obras registadas." cta={{ href: '/', label: 'Falar com o Capo' }} />
      </ScreenShell>
    </Screen>
  );
}
