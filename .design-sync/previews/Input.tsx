import { Input, Field } from '@capo/ui';

/** The bare control. In practice it is almost always rendered through a
 *  Field, which is what supplies its id and aria-* — see InsideAField. */
export function States() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxWidth: 340 }}>
      <Input placeholder="Casa de Paco" />
      <Input defaultValue="Vivenda do Zé" />
      <Input placeholder="Desactivado" disabled />
      <Input type="tel" placeholder="+351…" />
    </div>
  );
}

/** How it is actually used: the Field owns the label, hint and error, and
 *  hands the control everything it must carry. The border is 4.80:1 on the
 *  surface — that border is the ONLY signal a box is typeable. */
export function InsideAField() {
  return (
    <div style={{ maxWidth: 340 }}>
      <Field id="i-name" label="Nome da obra" hint="Como aparece na app" required>
        {a11y => <Input {...a11y} placeholder="Casa de Paco" />}
      </Field>
    </div>
  );
}

/** Invalid, driven by the Field's `error` — the control gets aria-invalid and
 *  a danger border, and the message is announced via role="alert". */
export function Invalid() {
  return (
    <div style={{ maxWidth: 340 }}>
      <Field id="i-email" label="Email" error="Esse email já está em uso">
        {a11y => <Input {...a11y} type="email" defaultValue="a@b.pt" />}
      </Field>
    </div>
  );
}
