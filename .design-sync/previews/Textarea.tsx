import { Textarea, Field } from '@capo/ui';

/** Same control surface as Input, with a 6rem minimum height and vertical
 *  resize. 16px type on the control itself is deliberate: iOS zooms the
 *  viewport when focusing anything smaller, and the app's viewport is locked
 *  so the zoom never comes back out. */
export function States() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxWidth: 340 }}>
      <Textarea placeholder="Detalhes da obra…" rows={3} />
      <Textarea defaultValue={'Falta material para o tecto.\nAvisar o Miguel na segunda.'} rows={3} />
      <Textarea placeholder="Desactivado" rows={2} disabled />
    </div>
  );
}

/** Through a Field, with a hint. */
export function InsideAField() {
  return (
    <div style={{ maxWidth: 340 }}>
      <Field id="t-notes" label="Notas" hint="Opcional — só tu vês isto">
        {a11y => <Textarea {...a11y} rows={4} placeholder="Detalhes da obra…" />}
      </Field>
    </div>
  );
}
