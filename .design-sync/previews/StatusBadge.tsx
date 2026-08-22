import { StatusBadge } from '@capo/ui';

const Row = ({ children }: { children: React.ReactNode }) => (
  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap', padding: '0.5rem' }}>
    {children}
  </div>
);

/** Every state a task can be in, in the order a job moves through them. */
export function AllStates() {
  return (
    <Row>
      <StatusBadge status="in_progress" locale="pt-PT" />
      <StatusBadge status="pending_review" locale="pt-PT" />
      <StatusBadge status="blocked" locale="pt-PT" />
      <StatusBadge status="done" locale="pt-PT" />
      <StatusBadge status="cancelled" locale="pt-PT" />
    </Row>
  );
}

/**
 * `pending` renders NOTHING by default — it is the state of almost every open
 * task, so a badge for it would occupy the one slot real state belongs in.
 * Pass showPending to opt back in.
 */
export function PendingIsHiddenByDefault() {
  return (
    <Row>
      <span style={{ fontSize: 12, color: '#71717a' }}>default:</span>
      <StatusBadge status="pending" locale="pt-PT" />
      <span style={{ fontSize: 12, color: '#71717a' }}>(nothing) · showPending:</span>
      <StatusBadge status="pending" locale="pt-PT" showPending />
    </Row>
  );
}

/** The same two states read in each of Capo's three languages. */
export function AcrossLanguages() {
  return (
    <div style={{ padding: '0.5rem' }}>
      {(['pt-PT', 'es-ES', 'en-US'] as const).map(locale => (
        <div key={locale} style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.4rem' }}>
          <code style={{ fontSize: 11, color: '#71717a', width: 46 }}>{locale}</code>
          <StatusBadge status="in_progress" locale={locale} />
          <StatusBadge status="pending_review" locale={locale} />
          <StatusBadge status="done" locale={locale} />
        </div>
      ))}
    </div>
  );
}
