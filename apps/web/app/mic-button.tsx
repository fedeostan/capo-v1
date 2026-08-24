'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';

// Voice input for the composer: tap to record, tap to stop, transcription
// lands in the text input via onTranscript — never auto-sent. The manager
// reviews before Capo sees anything (misheard commands must not fire).

const MAX_RECORDING_MS = 60_000;

// Chrome/Android record webm+opus, iOS Safari only mp4/AAC. The server passes
// whatever container was recorded straight through to the model.
const MIME_PREFERENCES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];

type MicState = 'idle' | 'recording' | 'transcribing';

function pickMimeType(): string | undefined {
  return MIME_PREFERENCES.find(t => MediaRecorder.isTypeSupported(t));
}

// Recording support is a client-only constant; the server snapshot (false)
// keeps SSR and hydration in agreement — the button appears client-side only.
const noSubscribe = () => () => {};
const isSupported = () => typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

export default function MicButton({
  disabled,
  locale,
  onTranscript,
}: {
  disabled: boolean;
  locale: Locale;
  onTranscript: (text: string) => void;
}) {
  const t = getCatalog(locale).mic;
  const supported = useSyncExternalStore(noSubscribe, isSupported, () => false);
  const [state, setState] = useState<MicState>('idle');
  const [hint, setHint] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const startingRef = useRef(false);
  const timersRef = useRef<{ autoStop?: ReturnType<typeof setTimeout>; tick?: ReturnType<typeof setInterval> }>({});

  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(null), 4000);
    return () => clearTimeout(t);
  }, [hint]);

  useEffect(
    () => () => {
      clearTimers();
      recorderRef.current?.stream.getTracks().forEach(track => track.stop());
    },
    [],
  );

  function clearTimers() {
    clearTimeout(timersRef.current.autoStop);
    clearInterval(timersRef.current.tick);
  }

  async function startRecording() {
    if (startingRef.current) return;
    startingRef.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: Blob[] = [];
      recorder.ondataavailable = e => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach(track => track.stop());
        void transcribe(new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' }));
      };
      recorderRef.current = recorder;
      recorder.start();
      setElapsed(0);
      setState('recording');
      timersRef.current.tick = setInterval(() => setElapsed(s => s + 1), 1000);
      timersRef.current.autoStop = setTimeout(stopRecording, MAX_RECORDING_MS);
    } catch {
      setHint(t.noAccess);
    } finally {
      startingRef.current = false;
    }
  }

  function stopRecording() {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;
    clearTimers();
    setState('transcribing');
    recorder.stop();
    recorderRef.current = null;
  }

  async function transcribe(blob: Blob) {
    try {
      const form = new FormData();
      form.append('audio', new File([blob], 'recording', { type: blob.type }));
      const res = await fetch('/api/transcribe', { method: 'POST', body: form });
      const data = (await res.json()) as { text?: string; error?: string };
      if (!res.ok) throw new Error(data.error);
      if (data.text) onTranscript(data.text);
      else setHint(t.notUnderstood);
    } catch {
      setHint(t.error);
    } finally {
      setState('idle');
    }
  }

  if (!supported) return null;

  return (
    <div className="relative flex items-center">
      {hint && (
        // A dark tooltip on a light page is the intended convention, and
        // `bg-fg text-bg` IS that convention expressed as a rule: it inverts
        // per theme, so the dark: twin that used to restore separation from
        // the near-black background is no longer needed. Same pair the
        // Banner's `neutral` tone uses.
        <span className="absolute -top-8 right-0 whitespace-nowrap rounded-chip bg-fg px-2 py-1 text-caption text-bg">
          {hint}
        </span>
      )}
      <button
        type="button"
        aria-label={state === 'recording' ? t.stop : t.record}
        disabled={disabled || state === 'transcribing'}
        onClick={state === 'recording' ? stopRecording : startRecording}
        // Deliberately NOT a <Button> variant, and the reason is the recording
        // state. A solid red here is a LIVE-RECORDING indicator — a fixed
        // signal colour, like a Banner and unlike a themed surface — so it uses
        // the pinned `-solid` pair that clears 4.5:1 in both themes. The
        // design's `destructive` variant is an outline and means "this deletes
        // something", which is the wrong sentence for a running microphone that
        // costs money until it is stopped.
        //
        // What it does adopt: min-h-11 (44px — this control was ~36px and is
        // one of the undersized targets the design set out to fix), the shared
        // radius, and the focus ring, which nothing in this file had.
        className={
          state === 'recording'
            ? 'flex min-h-11 items-center gap-2 rounded-control bg-danger-solid px-3 py-2 text-callout font-semibold text-on-solid outline-none transition-colors ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus'
            : 'flex min-h-11 items-center justify-center rounded-control border border-control px-3 py-2 text-callout text-fg outline-none transition-colors ease-out hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:pointer-events-none disabled:opacity-50'
        }
      >
        {state === 'idle' && <MicIcon />}
        {state === 'recording' && (
          <>
            <span className="h-2 w-2 animate-pulse rounded-chip bg-on-solid" />
            <span className="tabular-nums">{elapsed}s</span>
          </>
        )}
        {state === 'transcribing' && (
          <span className="block h-4 w-4 animate-spin rounded-full border-2 border-control border-t-transparent" />
        )}
      </button>
    </div>
  );
}

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}
