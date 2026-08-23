import { MicButton } from '@capo/ui';

/**
 * Dictation for the chat composer, sitting inside the composer it belongs to.
 *
 * It asks the browser whether speech recognition exists and renders NOTHING at
 * all when it does not — so this control is absent rather than broken on a
 * browser that cannot do it. Compose it expecting that: the composer's layout
 * must survive the button not being there.
 */
export function InAComposer() {
  return (
    <div style={{ maxWidth: 460, padding: '0.75rem', display: 'flex', gap: '0.5rem', alignItems: 'center',
                  border: '1px solid rgba(113,113,122,0.2)', borderRadius: 12 }}>
      <input placeholder="Escreve ao Capo…" style={{ flex: 1, border: 0, outline: 'none', fontSize: 14, background: 'transparent' }} />
      <MicButton locale="pt-PT" disabled={false} onTranscript={() => {}} />
    </div>
  );
}

/** Disabled — the chat passes this while a reply is streaming. */
export function Disabled() {
  return (
    <div style={{ maxWidth: 460, padding: '0.75rem', display: 'flex', gap: '0.5rem', alignItems: 'center',
                  border: '1px solid rgba(113,113,122,0.2)', borderRadius: 12 }}>
      <input placeholder="A responder…" disabled style={{ flex: 1, border: 0, outline: 'none', fontSize: 14, background: 'transparent' }} />
      <MicButton locale="pt-PT" disabled onTranscript={() => {}} />
    </div>
  );
}
