import { Field, Input, Select, Textarea, Card } from '@capo/ui';

/** Field takes a RENDER PROP, not a node: the control cannot be rendered
 *  without receiving the ids and aria-* it must carry, which is what makes
 *  the label/hint/error wiring impossible to forget. Spread it: {a11y => …} */
export function Required() {
  return (
    <Field id="p-name" label="Nome da obra" required>
      {a11y => <Input {...a11y} placeholder="Casa de Paco" />}
    </Field>
  );
}

/** A hint sits below the control and is referenced by aria-describedby, so a
 *  screen reader reads it as part of the field rather than as stray text. */
export function WithHint() {
  return (
    <Field id="p-phone" label="Telefone" hint="Com indicativo do país">
      {a11y => <Input {...a11y} type="tel" placeholder="+351…" />}
    </Field>
  );
}

/** An error replaces the hint, sets aria-invalid on the control, and is
 *  announced immediately via role="alert" rather than only when focus
 *  happens to land on the field. */
export function WithError() {
  return (
    <Field id="p-email" label="Email" error="Esse email já está em uso">
      {a11y => <Input {...a11y} type="email" defaultValue="a@b.pt" />}
    </Field>
  );
}

/** The whole form, as the gallery composes it — every control type wired
 *  through the same Field. A native <select> on purpose: it works offline and
 *  matches the phone's own picker. */
export function AWholeForm() {
  return (
    <Card>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <Field id="f-name" label="Nome da obra" required>
          {a11y => <Input {...a11y} placeholder="Casa de Paco" />}
        </Field>
        <Field id="f-lang" label="Idioma">
          {a11y => (
            <Select {...a11y} defaultValue="pt-PT">
              <option value="pt-PT">Português</option>
              <option value="es-ES">Español</option>
              <option value="en-US">English</option>
            </Select>
          )}
        </Field>
        <Field id="f-notes" label="Notas" hint="Opcional">
          {a11y => <Textarea {...a11y} rows={3} placeholder="Detalhes da obra…" />}
        </Field>
      </div>
    </Card>
  );
}
