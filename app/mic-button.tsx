'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

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
  onTranscript,
}: {
  disabled: boolean;
  onTranscript: (text: string) => void;
}) {
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
      setHint('Sem acesso ao microfone');
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
      else setHint('Não percebi — tenta outra vez');
    } catch {
      setHint('Erro ao transcrever');
    } finally {
      setState('idle');
    }
  }

  if (!supported) return null;

  return (
    <div className="relative flex items-center">
      {hint && (
        <span className="absolute -top-8 right-0 whitespace-nowrap rounded-lg bg-zinc-800 px-2 py-1 text-xs text-white">
          {hint}
        </span>
      )}
      <button
        type="button"
        aria-label={state === 'recording' ? 'Parar gravação' : 'Gravar mensagem de voz'}
        disabled={disabled || state === 'transcribing'}
        onClick={state === 'recording' ? stopRecording : startRecording}
        className={
          state === 'recording'
            ? 'flex items-center gap-1.5 rounded-xl bg-red-600 px-3 py-2 text-sm font-semibold text-white'
            : 'rounded-xl border border-zinc-500/30 px-3 py-2 text-sm hover:border-emerald-600 disabled:opacity-50'
        }
      >
        {state === 'idle' && <MicIcon />}
        {state === 'recording' && (
          <>
            <span className="h-2.5 w-2.5 animate-pulse rounded-sm bg-white" />
            <span className="tabular-nums">{elapsed}s</span>
          </>
        )}
        {state === 'transcribing' && (
          <span className="block h-4 w-4 animate-spin rounded-full border-2 border-zinc-400 border-t-transparent" />
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
