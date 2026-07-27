'use client';

import { useChat } from '@ai-sdk/react';
import { getToolName, isToolUIPart, type UIMessage } from 'ai';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getCatalog, type Catalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import Markdown from '@capo/ui/markdown';
import MicButton from './mic-button';

// This is a client component, so it receives `locale` (a plain string) and
// resolves the catalog itself — the catalog holds functions, which cannot be
// serialized across the RSC boundary. Nested components take the resolved
// catalog directly, since they are all on the client side of that line.

export interface PendingProposal {
  proposalId: string;
  renderedText: string;
}

type CardState = 'pending' | 'busy' | 'approved' | 'rejected' | 'failed' | 'not_pending' | 'error';

// Rehydrated cards derive their state from the persisted proposals.status —
// a resolved proposal must never come back with live buttons.
function dbStatusToCardState(status: string | undefined): CardState {
  switch (status) {
    case undefined: // streamed live this turn — not yet in the status snapshot
    case 'pending':
      return 'pending';
    case 'approved':
      return 'approved';
    case 'rejected':
      return 'rejected';
    case 'failed':
      return 'failed';
    default: // 'executing', 'expired'
      return 'not_pending';
  }
}

function ProposalCard({
  proposalId,
  renderedText,
  t,
  initialState = 'pending',
}: {
  proposalId: string;
  renderedText: string;
  t: Catalog;
  initialState?: CardState;
}) {
  const [state, setState] = useState<CardState>(initialState);
  const router = useRouter();

  async function decide(decision: 'approve' | 'reject') {
    setState('busy');
    try {
      const res = await fetch(`/api/proposals/${proposalId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      const data = await res.json();
      setState(data.outcome ?? 'error');
      // An approved proposal writes real tasks. Without this the manager taps
      // Approve, switches to Tasks, and sees the pre-approval board from the
      // router cache — which reads as "it didn't work".
      if (data.outcome === 'approved') router.refresh();
    } catch {
      setState('error');
    }
  }

  return (
    <div className="my-2 rounded-xl border border-amber-500/60 bg-amber-500/10 p-3 text-sm">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
        {t.chat.proposalTitle}
      </div>
      <p className="whitespace-pre-wrap">{renderedText}</p>
      {state === 'pending' || state === 'busy' ? (
        <div className="mt-3 flex gap-2">
          <button
            disabled={state === 'busy'}
            onClick={() => decide('approve')}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {t.chat.approve}
          </button>
          <button
            disabled={state === 'busy'}
            onClick={() => decide('reject')}
            className="rounded-lg border border-zinc-400 px-3 py-1.5 text-xs font-semibold hover:bg-zinc-500/10 disabled:opacity-50"
          >
            {t.chat.reject}
          </button>
        </div>
      ) : (
        <div className="mt-2 text-xs font-medium">{t.chat.cardState[state]}</div>
      )}
    </div>
  );
}

// The transport surfaces a non-2xx as an Error whose message carries the
// response body, so the causes we already answer deliberately (401 session
// gone, 402 billing) become something the manager can act on instead of a raw
// status code.
function errorHint(error: Error, t: Catalog): string {
  const message = error.message ?? '';
  if (/402|subscri|suscrip/i.test(message)) return t.chat.errorHints.billing;
  if (/401|autenticad|authenticat|autentic/i.test(message)) return t.chat.errorHints.auth;
  if (/fetch|network|NetworkError/i.test(message)) return t.chat.errorHints.network;
  return t.chat.errorHints.generic;
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="my-1 inline-block rounded-full border border-zinc-500/30 bg-zinc-500/10 px-2 py-0.5 text-xs text-zinc-500 dark:text-zinc-400">
      {children}
    </span>
  );
}

function Part({
  part,
  proposalStatuses,
  t,
  markdown,
}: {
  part: UIMessage['parts'][number];
  proposalStatuses: Record<string, string>;
  t: Catalog;
  markdown?: boolean;
}) {
  if (part.type === 'text') {
    if (!part.text) return null;
    // Capo writes markdown; the manager's own text stays literal.
    return markdown ? <Markdown text={part.text} /> : <p className="whitespace-pre-wrap">{part.text}</p>;
  }
  if (isToolUIPart(part)) {
    const name = getToolName(part);
    const label = t.chat.toolLabels[name] ?? name;
    if (part.state === 'output-available') {
      const out = part.output as
        | { status?: string; proposalId?: string; renderedText?: string; reason?: string }
        | undefined;
      if (out?.status === 'proposed' && out.proposalId && out.renderedText) {
        return (
          <ProposalCard
            proposalId={out.proposalId}
            renderedText={out.renderedText}
            t={t}
            initialState={dbStatusToCardState(proposalStatuses[out.proposalId])}
          />
        );
      }
      if (out?.status === 'error') return <Chip>⚠️ {label}</Chip>;
      return <Chip>✓ {label}</Chip>;
    }
    if (part.state === 'output-error') return <Chip>⚠️ {label}</Chip>;
    return <Chip>… {label}</Chip>;
  }
  return null;
}

export default function Chat({
  initialMessages,
  locale,
  proposalStatuses = {},
  orphanedPending = [],
  initialInput = '',
}: {
  initialMessages: UIMessage[];
  locale: Locale;
  proposalStatuses?: Record<string, string>;
  orphanedPending?: PendingProposal[];
  /** Composer prefill from ?q= — e.g. "Ask Capo about this task" on /tarefas/[id]. */
  initialInput?: string;
}) {
  const t = getCatalog(locale);
  // Prefill FILLS the composer, it never auto-sends — same rule as the mic
  // below: the manager reads what is about to be sent in his name.
  const [input, setInput] = useState(initialInput);
  const router = useRouter();
  const { messages, sendMessage, status, error, stop, clearError, regenerate } = useChat({
    messages: initialMessages,
    // A turn can create tasks, jobs or workers. Every dashboard screen is a
    // server component behind the router cache, so without an explicit refresh
    // they keep serving the pre-turn snapshot until a hard reload.
    onFinish: () => router.refresh(),
  });
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // What the mic inserted this composer round; compared against the sent text
  // so vocab learning only sees genuine transcription corrections.
  const transcriptRef = useRef('');
  // Kept so retry can resend a message the server never accepted (402 billing,
  // 500, dropped connection). Otherwise the manager has to retype it — and a
  // pasted quote is not something anyone retypes.
  const lastSentRef = useRef('');
  // Tool-call ids already acted on, so a re-render never re-refreshes.
  const handledLanguageCalls = useRef(new Set<string>());

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // The front door of the product is "paste the quote". Grow the composer with
  // the text (to a third of the viewport) instead of hiding it in a one-line
  // box that flattens every newline.
  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight / 3))}px`;
  }, []);

  useEffect(autoGrow, [input, autoGrow]);

  // set_language writes profiles.language, but everything around this chat —
  // the nav, the dashboard, <html lang> — was server-rendered in the OLD
  // language and has no idea. Refreshing the server components is what makes
  // the whole app flip mid-conversation instead of at the next navigation.
  useEffect(() => {
    for (const message of messages) {
      for (const part of message.parts) {
        if (!isToolUIPart(part) || getToolName(part) !== 'set_language') continue;
        if (part.state !== 'output-available') continue;
        if (handledLanguageCalls.current.has(part.toolCallId)) continue;
        handledLanguageCalls.current.add(part.toolCallId);
        router.refresh();
      }
    }
  }, [messages, router]);

  const busy = status === 'submitted' || status === 'streaming';

  function send(text: string) {
    lastSentRef.current = text;
    clearError();
    sendMessage({ text });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    const transcript = transcriptRef.current.trim();
    transcriptRef.current = '';
    if (transcript && transcript !== text) {
      // Fire-and-forget: learning must never delay or block sending.
      void fetch('/api/transcribe/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript, final: text }),
      }).catch(() => {});
    }
    send(text);
    setInput('');
  }

  // Enter sends; Shift+Enter inserts a newline. isComposing guards IME input,
  // where Enter commits a candidate rather than ending the message.
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit(e);
    }
  }

  function retry() {
    const text = lastSentRef.current;
    clearError();
    // If the failed turn never made it into `messages`, resend it. If it did,
    // the user message is already there and only the response failed.
    if (text && messages[messages.length - 1]?.role !== 'user') send(text);
    else void regenerate();
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col">
      <header className="border-b border-zinc-500/20 px-4 py-3">
        <h1 className="text-lg font-semibold">{t.chat.title}</h1>
        <p className="text-xs text-zinc-500">{t.chat.tagline}</p>
      </header>

      <main className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {orphanedPending.length > 0 && (
          <section className="rounded-xl border border-zinc-500/20 p-3">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              {t.chat.pendingProposals}
            </div>
            {orphanedPending.map(p => (
              <ProposalCard key={p.proposalId} proposalId={p.proposalId} renderedText={p.renderedText} t={t} />
            ))}
          </section>
        )}
        {messages.length === 0 && (
          <p className="pt-10 text-center text-sm text-zinc-500">{t.chat.emptyThread}</p>
        )}
        {messages.map(message =>
          message.role === 'system' ? (
            <div key={message.id} className="text-center text-xs italic text-zinc-500">
              {message.parts.map((part, i) => (part.type === 'text' ? <span key={i}>{part.text}</span> : null))}
            </div>
          ) : (
            <div key={message.id} className={message.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
              <div
                className={
                  message.role === 'user'
                    ? 'max-w-[85%] rounded-2xl rounded-br-sm bg-emerald-700 px-3 py-2 text-sm text-white'
                    : 'max-w-[85%] rounded-2xl rounded-bl-sm bg-zinc-500/10 px-3 py-2 text-sm'
                }
              >
                {message.parts.map((part, i) => (
                  <Part
                    key={`${message.id}-${i}`}
                    part={part}
                    proposalStatuses={proposalStatuses}
                    t={t}
                    markdown={message.role === 'assistant'}
                  />
                ))}
              </div>
            </div>
          ),
        )}
        {busy && (
          <div className="flex items-center gap-3 text-xs text-zinc-500">
            <span>{t.chat.typing}</span>
            <button type="button" onClick={stop} className="underline hover:text-zinc-400">
              {t.chat.stop}
            </button>
          </div>
        )}
        {/* Before this, a 402 (subscription expired) or a 500 left the manager
            staring at a message that never got an answer, with nothing to act
            on. Silence is the worst failure mode a chat product has. */}
        {error && (
          <div className="rounded-xl border border-red-500/50 bg-red-500/10 p-3 text-sm">
            <p className="font-medium text-red-600 dark:text-red-400">{t.chat.errorTitle}</p>
            <p className="mt-0.5 text-xs text-zinc-500">{errorHint(error, t)}</p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={retry}
                className="rounded-lg bg-zinc-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-600"
              >
                {t.chat.retry}
              </button>
              <button
                type="button"
                onClick={clearError}
                className="rounded-lg border border-zinc-400 px-3 py-1.5 text-xs font-semibold hover:bg-zinc-500/10"
              >
                {t.chat.dismiss}
              </button>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </main>

      <form onSubmit={handleSubmit} className="flex items-end gap-2 border-t border-zinc-500/20 p-3">
        <textarea
          ref={textareaRef}
          rows={1}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t.chat.placeholder}
          className="max-h-[33vh] flex-1 resize-none rounded-xl border border-zinc-500/30 bg-transparent px-3 py-2 text-base outline-none focus:border-emerald-600"
        />
        {/* Transcription only fills the input — the manager reviews and sends. */}
        <MicButton
          disabled={busy}
          locale={locale}
          onTranscript={text => {
            transcriptRef.current = transcriptRef.current ? `${transcriptRef.current} ${text}` : text;
            setInput(prev => (prev.trim() ? `${prev.trimEnd()} ${text}` : text));
          }}
        />
        <button
          type="submit"
          disabled={busy || input.trim().length === 0}
          className="shrink-0 rounded-xl bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-50"
        >
          {t.chat.send}
        </button>
      </form>
    </div>
  );
}
