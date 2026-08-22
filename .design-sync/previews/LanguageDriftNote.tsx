import { LanguageDriftNote } from '@capo/ui';

/**
 * The /perfil version: the same sentence as the board strip, plus the
 * explanation, sitting directly above the control that fixes it. Amber rather
 * than the strip's quiet grey — here there IS something to act on.
 */
export function ManagerReadsEnglish() {
  return <div style={{ maxWidth: 460, padding: '0.5rem' }}><LanguageDriftNote locale="en-US" companyLocale="pt-PT" /></div>;
}

/** A Spanish manager over Portuguese-stored data. */
export function ManagerReadsSpanish() {
  return <div style={{ maxWidth: 460, padding: '0.5rem' }}><LanguageDriftNote locale="es-ES" companyLocale="pt-PT" /></div>;
}

/** Dials agreeing renders nothing at all. */
export function DialsAgreeRendersNothing() {
  return (
    <div style={{ maxWidth: 460, padding: '0.5rem' }}>
      <LanguageDriftNote locale="pt-PT" companyLocale="pt-PT" />
      <p style={{ fontSize: 12, color: '#71717a', fontStyle: 'italic' }}>(nothing rendered — locale === companyLocale)</p>
    </div>
  );
}
