import { ButtonLink } from '@capo/ui';

/** The same surface as Button, over an anchor. Deliberately a plain <a>
 *  rather than next/link: @capo/ui is shared with apps/operator and must not
 *  depend on a router. Defaults to `secondary`, unlike Button — a link that
 *  looks like the screen's one primary action usually is not it. */
export function Variants() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
      <ButtonLink href="#">Ver obra</ButtonLink>
      <ButtonLink href="#" variant="primary">Abrir tarefa</ButtonLink>
      <ButtonLink href="#" variant="tertiary">Ver tudo</ButtonLink>
    </div>
  );
}

/** Full width, as it appears at the end of an empty state or a detail screen. */
export function FullWidth() {
  return (
    <div style={{ maxWidth: 360 }}>
      <ButtonLink href="#" variant="primary" fullWidth>Falar com o Capo</ButtonLink>
    </div>
  );
}
