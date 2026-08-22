import { EmptyState } from '@capo/ui';

/** The standard empty screen: a sentence plus the one thing worth doing next. */
export function WithCallToAction() {
  return <EmptyState text="Ainda não há obras registadas." cta={{ href: '/', label: 'Falar com o Capo' }} />;
}

/** No action to offer — the sentence stands alone. */
export function TextOnly() {
  return <EmptyState text="Nenhum material registado para esta semana." />;
}

/** Where it actually appears: inside a screen, not floating on its own. */
export function InContext() {
  return (
    <div style={{ border: '1px solid rgba(113,113,122,0.2)', borderRadius: 12, padding: '0.5rem' }}>
      <EmptyState text="Nada marcado para hoje." cta={{ href: '/', label: 'Falar com o Capo' }} />
    </div>
  );
}
