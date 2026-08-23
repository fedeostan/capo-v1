import { PushCard } from '@capo/ui';

/**
 * The /perfil notifications card. It enumerates every permission state rather
 * than rendering a button, because both failure modes are SILENT: the browser
 * prompt is one-shot, and iOS only allows push once the app is installed to
 * the home screen. What renders here is whatever state the viewing browser is
 * actually in.
 */
export function OnThisBrowser() {
  return (
    <div style={{ maxWidth: 460, padding: '0.75rem' }}>
      <PushCard locale="pt-PT" vapidPublicKey="BEl62iUYgUivxIkv69yViEuiBIa1HI0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" />
    </div>
  );
}

/** The same card in English. */
export function English() {
  return (
    <div style={{ maxWidth: 460, padding: '0.75rem' }}>
      <PushCard locale="en-US" vapidPublicKey="BEl62iUYgUivxIkv69yViEuiBIa1HI0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" />
    </div>
  );
}
