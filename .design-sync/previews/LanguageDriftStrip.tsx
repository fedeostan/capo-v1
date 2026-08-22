import { LanguageDriftStrip } from '@capo/ui';

/**
 * Shown above the /tarefas board when the manager reads one language and the
 * company STORES another — a legal state that nothing used to announce.
 */
export function ManagerReadsEnglish() {
  return <div style={{ maxWidth: 460, padding: '0.5rem' }}><LanguageDriftStrip locale="en-US" companyLocale="pt-PT" /></div>;
}

/** The mirror case: a Portuguese manager over Spanish-stored data. */
export function ManagerReadsPortuguese() {
  return <div style={{ maxWidth: 460, padding: '0.5rem' }}><LanguageDriftStrip locale="pt-PT" companyLocale="es-ES" /></div>;
}

/** Dials agreeing renders NOTHING — which is every tenant that never split them. */
export function DialsAgreeRendersNothing() {
  return (
    <div style={{ maxWidth: 460, padding: '0.5rem' }}>
      <LanguageDriftStrip locale="pt-PT" companyLocale="pt-PT" />
      <p style={{ fontSize: 12, color: '#71717a', fontStyle: 'italic' }}>(nothing rendered — locale === companyLocale)</p>
    </div>
  );
}
