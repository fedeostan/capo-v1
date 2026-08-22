import { InstallGuide } from '@capo/ui';

/**
 * The /instalar screen. It detects the platform and shows the steps for THAT
 * browser, so what renders here is the guide for whichever browser is viewing
 * — on desktop Chromium, the generic menu-based instructions.
 */
export function ForThisBrowser() {
  return <div style={{ maxWidth: 460, padding: '0.75rem' }}><InstallGuide locale="pt-PT" /></div>;
}

/** The same guide in Spanish. */
export function Spanish() {
  return <div style={{ maxWidth: 460, padding: '0.75rem' }}><InstallGuide locale="es-ES" /></div>;
}

/** And in English. */
export function English() {
  return <div style={{ maxWidth: 460, padding: '0.75rem' }}><InstallGuide locale="en-US" /></div>;
}
