import { TranslationProgress } from '@capo/ui';

/**
 * IMPORTANT for anyone composing this component.
 *
 * TranslationProgress DRIVES ITSELF: on mount it POSTs to
 * /api/translation/<batchId>/run and loops until the batch stops. So its
 * `initialStatus` is a starting point, not a display prop — with no API behind
 * it the first request fails and the component settles into its stopped state,
 * deliberately keeping the last known counts on screen because the batch row
 * remains the source of truth and a reload picks it back up.
 *
 * That is why these cells show the STOPPED state rather than running/completed
 * ones: those cannot be rendered without a live endpoint, and a card labelled
 * "Completed" that actually showed "stopped" would be a lie the design agent
 * would copy. The progress bar below is real — it reflects the counts passed in.
 */
export function StoppedEarly() {
  return (
    <div style={{ maxWidth: 460, padding: '0.75rem' }}>
      <TranslationProgress locale="pt-PT" batchId="b1" initialStatus="running" initialDone={37} initialTotal={112} />
    </div>
  );
}

/** Stopped with almost everything already rewritten — the bar reflects the counts. */
export function StoppedNearTheEnd() {
  return (
    <div style={{ maxWidth: 460, padding: '0.75rem' }}>
      <TranslationProgress locale="pt-PT" batchId="b2" initialStatus="running" initialDone={108} initialTotal={112} />
    </div>
  );
}

/** The same stopped state read in English. */
export function English() {
  return (
    <div style={{ maxWidth: 460, padding: '0.75rem' }}>
      <TranslationProgress locale="en-US" batchId="b3" initialStatus="running" initialDone={37} initialTotal={112} />
    </div>
  );
}
