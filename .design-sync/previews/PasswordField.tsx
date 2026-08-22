import { PasswordField } from '@capo/ui';

/** Signing in: the reveal control that let somebody see what they are typing. */
export function SignIn() {
  return (
    <div style={{ maxWidth: 380, padding: '0.75rem' }}>
      <PasswordField locale="pt-PT" label="Palavra-passe" autoComplete="current-password" />
    </div>
  );
}

/** Creating an account — a minimum length applies. */
export function NewPassword() {
  return (
    <div style={{ maxWidth: 380, padding: '0.75rem' }}>
      <PasswordField locale="pt-PT" label="Nova palavra-passe" autoComplete="new-password" minLength={8} />
    </div>
  );
}

/** The same field in all three languages, stacked. */
export function AcrossLanguages() {
  return (
    <div style={{ maxWidth: 380, padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      <PasswordField locale="pt-PT" label="Palavra-passe" autoComplete="current-password" />
      <PasswordField locale="es-ES" label="Contraseña" autoComplete="current-password" />
      <PasswordField locale="en-US" label="Password" autoComplete="current-password" />
    </div>
  );
}
