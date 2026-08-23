import { Select, Field } from '@capo/ui';

/** A native <select> on purpose: it works offline, matches the phone's own
 *  picker, and handles keyboards correctly. A custom one would be a modal, a
 *  focus trap and a scroll lock to maintain for no gain.
 *
 *  `appearance-none` strips the OS arrow so the control matches the other
 *  fields, which means we owe it a replacement — the chevron is drawn in and
 *  is pointer-events-none, so every click still lands on the select. */
export function States() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxWidth: 340 }}>
      <Select defaultValue="pt-PT">
        <option value="pt-PT">Português</option>
        <option value="es-ES">Español</option>
        <option value="en-US">English</option>
      </Select>
      <Select defaultValue="" disabled>
        <option value="">Desactivado</option>
      </Select>
    </div>
  );
}

/** Through a Field, which is how every select in the product is wired. */
export function InsideAField() {
  return (
    <div style={{ maxWidth: 340 }}>
      <Field id="s-worker" label="Responsável" hint="Quem lidera esta tarefa">
        {a11y => (
          <Select {...a11y} defaultValue="miguel">
            <option value="miguel">Miguel</option>
            <option value="ze">Zé</option>
            <option value="joao">João</option>
          </Select>
        )}
      </Field>
    </div>
  );
}
