'use client';

import { useChat } from '@ai-sdk/react';
import { getToolName, isToolUIPart, type UIMessage } from 'ai';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { getCatalog, type Catalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import Markdown from '@capo/ui/markdown';
import { Button } from '@capo/ui/button';
import { Badge } from '@capo/ui/badge';
import { Card } from '@capo/ui/card';
import MicButton from './mic-button';
import PullToRefresh from './pull-to-refresh';

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
  // Which button was pressed, so only that one turns into a spinner.
  const [pressed, setPressed] = useState<'approve' | 'reject' | null>(null);
  const [isRefreshing, startTransition] = useTransition();
  const router = useRouter();

  async function decide(decision: 'approve' | 'reject') {
    setPressed(decision);
    setState('busy');
    try {
      const res = await fetch(`/api/proposals/${proposalId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision }),
      });
      const data = await res.json();
      // res.ok explicitly: a 401 (session gone) or 402 (billing) answers with
      // a body that has no `outcome`, and landing on 'error' should be by
      // intent rather than by the ?? falling through.
      setState(res.ok ? (data.outcome ?? 'error') : 'error');
      // An approved proposal writes real tasks. Without this the manager taps
      // Approve, switches to Tasks, and sees the pre-approval board from the
      // router cache — which reads as "it didn't work".
      //
      // Wrapped in a transition because router.refresh() is fire-and-forget:
      // on a 15-task plan the RSC refetch keeps running after this fetch
      // resolves, and isRefreshing is the only way to make that window
      // visible instead of silent.
      if (res.ok && data.outcome === 'approved') startTransition(() => router.refresh());
    } catch {
      setState('error');
    } finally {
      setPressed(null);
    }
  }

  // Approving a plan writes a row per task, so this is seconds, not
  // milliseconds. Disabled-and-faded alone reads as a frozen app.
  const spinner = (
    <span
      className="inline-block h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
      aria-hidden
    />
  );

  return (
    // `warn`, not `review`. Violet means "a completion claim awaiting the
    // manager"; this is a write awaiting his approval, which is what the amber
    // card has always said. A restyle does not get to redefine a meaning.
    <div className="my-2 rounded-card border border-warn bg-warn-quiet p-3 text-body">
      <div className="mb-1 text-micro font-semibold uppercase tracking-wide text-warn">
        {t.chat.proposalTitle}
      </div>
      <p className="whitespace-pre-wrap">{renderedText}</p>
      {state === 'pending' || state === 'busy' ? (
        <div className="mt-3 flex gap-2" aria-busy={state === 'busy'}>
          {/* Approve is the one primary on this card, and `loading` holds the
              button's exact width so the pair does not shift under the thumb
              that just tapped it. The spinner now carries what the "a decidir"
              label used to say; aria-busy on the row above says it out loud. */}
          <Button
            variant="primary"
            size="sm"
            loading={state === 'busy' && pressed === 'approve'}
            disabled={state === 'busy'}
            onClick={() => decide('approve')}
          >
            {t.chat.approve}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            loading={state === 'busy' && pressed === 'reject'}
            disabled={state === 'busy'}
            onClick={() => decide('reject')}
          >
            {t.chat.reject}
          </Button>
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-2 text-caption font-medium">
          {t.chat.cardState[state]}
          {/* The board is still refetching — the decision landed, the screens
              behind it have not caught up yet. */}
          {isRefreshing ? (
            <span role="status" aria-label={t.chat.deciding}>
              {spinner}
            </span>
          ) : null}
        </div>
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

// The tool-activity marker. Badge is exactly this shape, and being read as a
// shape rather than as a sentence is why it is the one place 11px is allowed.
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="my-1 inline-block">
      <Badge tone="neutral">{children}</Badge>
    </span>
  );
}

// Mirrors asProposalOutput in packages/core/src/channels/whatsapp.ts on purpose:
// the two channels must agree on what a card is, and now also on the rule below.
function asProposal(
  part: UIMessage['parts'][number],
): { proposalId: string; renderedText: string } | null {
  if (!isToolUIPart(part) || part.state !== 'output-available') return null;
  const out = part.output as { status?: string; proposalId?: string; renderedText?: string } | undefined;
  if (out?.status !== 'proposed' || !out.proposalId || !out.renderedText) return null;
  return { proposalId: out.proposalId, renderedText: out.renderedText };
}

// A CARD TRAVELS ALONE — the screen half of the rule enforced for WhatsApp in
// planAssistantMessages. A message that carries an approval card shows ONLY the
// card: whatever Capo wrote around it is a second telling of what the card
// already says, deterministically, with the buttons attached. Tool chips are
// unaffected; they are activity markers, not a message.
function hasProposal(parts: UIMessage['parts']): boolean {
  return parts.some(part => asProposal(part) !== null);
}

function Part({
  part,
  proposalStatuses,
  t,
  markdown,
  suppressText = false,
}: {
  part: UIMessage['parts'][number];
  proposalStatuses: Record<string, string>;
  t: Catalog;
  markdown?: boolean;
  /** True when this message carries an approval card — see hasProposal. */
  suppressText?: boolean;
}) {
  if (part.type === 'text') {
    if (!part.text || suppressText) return null;
    // Capo writes markdown; the manager's own text stays literal.
    return markdown ? <Markdown text={part.text} /> : <p className="whitespace-pre-wrap">{part.text}</p>;
  }
  if (isToolUIPart(part)) {
    const name = getToolName(part);
    const label = t.chat.toolLabels[name] ?? name;
    if (part.state === 'output-available') {
      const out = part.output as { status?: string } | undefined;
      const proposal = asProposal(part);
      if (proposal) {
        return (
          <ProposalCard
            proposalId={proposal.proposalId}
            renderedText={proposal.renderedText}
            t={t}
            initialState={dbStatusToCardState(proposalStatuses[proposal.proposalId])}
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
  autoVoice = false,
  autoFocus = false,
  onboarding = false,
}: {
  initialMessages: UIMessage[];
  locale: Locale;
  proposalStatuses?: Record<string, string>;
  orphanedPending?: PendingProposal[];
  /** Composer prefill from ?q= — e.g. "Ask Capo about this task" on /tarefas/[id]. */
  initialInput?: string;
  /** ?voice=1 — the top bar's voice-note button. Arms the recorder on mount. */
  autoVoice?: boolean;
  /** ?compose=1 — the top bar's + button. Puts the cursor in the composer.
   *  The + goes to the chat rather than a form ON PURPOSE: telling Capo about
   *  a job IS how a task gets made here (create_task), so this is the product
   *  rather than a workaround for a missing screen. */
  autoFocus?: boolean;
  /** companies.onboarded_at is still null (migration 0046): this manager has
   *  not finished setting the company up, so the empty screen asks him to start
   *  rather than describing what Capo does in general. */
  onboarding?: boolean;
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

  // ?compose=1 puts the cursor in the composer. Mount only: `autoFocus` comes
  // from the URL the page was opened with, so re-focusing on any later render
  // would yank the keyboard back up under a manager who had dismissed it.
  // The caret goes to the END so a ?q= prefill can be typed onto rather than
  // overwritten.
  useEffect(() => {
    if (!autoFocus) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, [autoFocus]);

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

      {/* Pull-to-refresh is present for consistency with the other tabs, but
          nearly inert here by construction: the thread is bottom-anchored, so
          scrollTop is almost never 0, and chat already refreshes itself after
          every turn. `disabled` while streaming, because refreshing the tree
          under a live response would be actively harmful. */}
      <PullToRefresh
        locale={locale}
        disabled={busy}
        className="flex-1 space-y-3 overflow-y-auto overscroll-contain bg-bg px-4 py-4"
      >
          {orphanedPending.length > 0 && (
            <Card as="section" padding="sm">
              <div className="mb-1 text-micro font-semibold uppercase tracking-wide text-fg-muted">
                {t.chat.pendingProposals}
              </div>
              {orphanedPending.map(p => (
                <ProposalCard key={p.proposalId} proposalId={p.proposalId} renderedText={p.renderedText} t={t} />
              ))}
            </Card>
          )}
          {messages.length === 0 && (
            <p className="pt-12 text-center text-callout text-fg-muted">
              {onboarding ? t.chat.emptyThreadOnboarding : t.chat.emptyThread}
            </p>
          )}
          {messages.map(message =>
            message.role === 'system' ? (
              <div key={message.id} className="text-center text-caption italic text-fg-muted">
                {message.parts.map((part, i) => (part.type === 'text' ? <span key={i}>{part.text}</span> : null))}
              </div>
            ) : (
              <div key={message.id} className={message.role === 'user' ? 'flex justify-end' : 'flex justify-start'}>
                <div
                  className={
                    message.role === 'user'
                      ? 'max-w-[85%] rounded-card rounded-br-sm bg-brand px-3 py-2 text-body text-on-brand'
                      : 'max-w-[85%] rounded-card rounded-bl-sm border border-hairline bg-surface px-3 py-2 text-body text-fg'
                  }
                >
                  {message.parts.map((part, i) => (
                    <Part
                      key={`${message.id}-${i}`}
                      part={part}
                      proposalStatuses={proposalStatuses}
                      t={t}
                      markdown={message.role === 'assistant'}
                      suppressText={message.role === 'assistant' && hasProposal(message.parts)}
                    />
                  ))}
                </div>
              </div>
            ),
          )}
          {busy && (
            <div className="flex items-center gap-3 text-caption text-fg-muted">
              <span>{t.chat.typing}</span>
              {/* The hover no longer needs a dark: twin. It used to, because a
                  single zinc-400 faded out on white; --fg answers per theme,
                  so one rule now darkens in light and lightens in dark. */}
              <button
                type="button"
                onClick={stop}
                className="underline transition-colors ease-out hover:text-fg"
              >
                {t.chat.stop}
              </button>
            </div>
          )}
          {/* Before this, a 402 (subscription expired) or a 500 left the manager
              staring at a message that never got an answer, with nothing to act
              on. Silence is the worst failure mode a chat product has. */}
          {error && (
            <div className="rounded-card border border-danger bg-danger-quiet p-3 text-body">
              <p className="font-medium text-danger">{t.chat.errorTitle}</p>
              <p className="mt-1 text-caption text-fg-muted">{errorHint(error, t)}</p>
              <div className="mt-2 flex gap-2">
                {/* Retry is primary and Dismiss is secondary, which is the same
                    hierarchy the old hand-written pair was reaching for when it
                    picked brand orange over a grey slab that read as disabled. */}
                <Button variant="primary" size="sm" onClick={retry}>
                  {t.chat.retry}
                </Button>
                <Button variant="secondary" size="sm" onClick={clearError}>
                  {t.chat.dismiss}
                </Button>
              </div>
            </div>
          )}
          <div ref={bottomRef} />
      </PullToRefresh>

      <form onSubmit={handleSubmit} className="flex shrink-0 items-end gap-2 border-t border-hairline bg-surface p-3">
        <textarea
          ref={textareaRef}
          rows={1}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t.chat.placeholder}
          // Deliberately NOT the shared <Textarea>: that component fixes a
          // min-height and a resize handle, and this one has to start at one
          // row, grow with what is typed and stop at a third of the screen.
          // @capo/ui components refuse a className prop on purpose, so the
          // honest answer is bespoke markup built from the same tokens.
          className="max-h-[33vh] flex-1 resize-none rounded-control border border-control bg-surface px-3 py-2 text-body text-fg outline-none transition-colors ease-out focus:border-brand"
        />
        {/* Transcription only fills the input — the manager reviews and sends. */}
        <MicButton
          disabled={busy}
          autoStart={autoVoice}
          locale={locale}
          onTranscript={text => {
            transcriptRef.current = transcriptRef.current ? `${transcriptRef.current} ${text}` : text;
            setInput(prev => (prev.trim() ? `${prev.trimEnd()} ${text}` : text));
          }}
        />
        <Button type="submit" disabled={busy || input.trim().length === 0}>
          {t.chat.send}
        </Button>
      </form>
    </div>
  );
}
