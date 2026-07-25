'use client';

import { useChat } from '@ai-sdk/react';
import { getToolName, isToolUIPart, type UIMessage } from 'ai';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import Markdown from '@capo/ui/markdown';
import MicButton from './mic-button';

const TOOL_LABELS: Record<string, string> = {
  create_task: 'Tarefa criada',
  update_task: 'Tarefa atualizada',
  list_tasks: 'Tarefas consultadas',
  agenda: 'Agenda consultada',
  materials_outlook: 'Materiais consultados',
  create_job: 'Obra criada',
  update_job: 'Obra atualizada',
  list_jobs: 'Obras consultadas',
  add_worker: 'Trabalhador adicionado',
  update_worker: 'Trabalhador atualizado',
  list_workers: 'Equipa consultada',
  remember: 'Memorizado',
  search_knowledge: 'Base de conhecimento consultada',
  propose: 'Proposta criada',
  generate_plan: 'Plano gerado',
};

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
  initialState = 'pending',
}: {
  proposalId: string;
  renderedText: string;
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
      // An approved proposal writes real tasks. Without this, the manager taps
      // Aprovar, switches to Hoje, and sees the pre-approval list from the
      // router cache — reading as "it didn't work".
      if (data.outcome === 'approved') router.refresh();
    } catch {
      setState('error');
    }
  }

  return (
    <div className="my-2 rounded-xl border border-amber-500/60 bg-amber-500/10 p-3 text-sm">
      <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
        Proposta do Capo
      </div>
      <p className="whitespace-pre-wrap">{renderedText}</p>
      {state === 'pending' || state === 'busy' ? (
        <div className="mt-3 flex gap-2">
          <button
            disabled={state === 'busy'}
            onClick={() => decide('approve')}
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            Aprovar
          </button>
          <button
            disabled={state === 'busy'}
            onClick={() => decide('reject')}
            className="rounded-lg border border-zinc-400 px-3 py-1.5 text-xs font-semibold hover:bg-zinc-500/10 disabled:opacity-50"
          >
            Rejeitar
          </button>
        </div>
      ) : (
        <div className="mt-2 text-xs font-medium">
          {state === 'approved' && '✅ Aprovada — executada'}
          {state === 'rejected' && '❌ Rejeitada'}
          {state === 'failed' && '⚠️ Aprovada, mas a execução falhou'}
          {state === 'not_pending' && 'Esta proposta já foi resolvida'}
          {state === 'error' && '⚠️ Erro ao resolver a proposta'}
        </div>
      )}
    </div>
  );
}

// The transport surfaces a non-2xx as an Error whose message carries the
// response body, so the specific causes we already answer deliberately (401
// session gone, 402 billing) can be translated into something the manager can
// act on instead of a raw status code.
function errorHint(error: Error): string {
  const message = error.message ?? '';
  if (/subscri|402/i.test(message)) return 'A subscrição expirou. Vai a Subscrição para reativar.';
  if (/autenticad|401/i.test(message)) return 'A sessão terminou. Volta a entrar.';
  if (/fetch|network|Failed to fetch/i.test(message)) return 'Sem ligação. Verifica a rede e tenta outra vez.';
  return 'Pode ter sido a rede ou uma falha momentânea. A tua mensagem não se perdeu.';
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
  markdown,
}: {
  part: UIMessage['parts'][number];
  proposalStatuses: Record<string, string>;
  markdown?: boolean;
}) {
  if (part.type === 'text') {
    if (!part.text) return null;
    // Capo writes markdown; the manager's own text stays literal.
    return markdown ? <Markdown text={part.text} /> : <p className="whitespace-pre-wrap">{part.text}</p>;
  }
  if (isToolUIPart(part)) {
    const name = getToolName(part);
    const label = TOOL_LABELS[name] ?? name;
    if (part.state === 'output-available') {
      const out = part.output as
        | { status?: string; proposalId?: string; renderedText?: string; reason?: string }
        | undefined;
      if (out?.status === 'proposed' && out.proposalId && out.renderedText) {
        return (
          <ProposalCard
            proposalId={out.proposalId}
            renderedText={out.renderedText}
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
  proposalStatuses = {},
  orphanedPending = [],
}: {
  initialMessages: UIMessage[];
  proposalStatuses?: Record<string, string>;
  orphanedPending?: PendingProposal[];
}) {
  const [input, setInput] = useState('');
  const router = useRouter();
  const { messages, sendMessage, status, error, stop, clearError, regenerate } = useChat({
    messages: initialMessages,
    // A turn can create tasks, obras or workers. The dashboard tabs are server
    // components behind the router cache, so without an explicit refresh they
    // keep serving the pre-turn snapshot until a hard reload.
    onFinish: () => router.refresh(),
  });
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // What the mic inserted this composer round; compared against the sent text
  // so vocab learning only sees genuine transcription corrections.
  const transcriptRef = useRef('');
  // Kept so "Tentar outra vez" can resend a message the server never accepted
  // (402 billing, 500, dropped connection) — otherwise the manager has to
  // retype it, and a pasted orçamento is not something anyone retypes.
  const lastSentRef = useRef('');

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const busy = status === 'submitted' || status === 'streaming';

  // The front door of the product is "paste the orçamento". Grow the composer
  // with the text (to a third of the viewport) instead of hiding it in a
  // one-line box.
  const autoGrow = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight / 3))}px`;
  }, []);

  useEffect(autoGrow, [input, autoGrow]);

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

  // Enter sends, Shift+Enter (and the on-screen keyboard's return on mobile,
  // which does not report shiftKey) inserts a newline.
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSubmit(e);
    }
  }

  function retry() {
    const text = lastSentRef.current;
    clearError();
    // If the failed turn never made it into `messages`, resend it; otherwise
    // the message is there and only the response failed.
    if (text && messages[messages.length - 1]?.role !== 'user') send(text);
    else void regenerate();
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-col">
      <header className="border-b border-zinc-500/20 px-4 py-3">
        <h1 className="text-lg font-semibold">Capo 👷</h1>
        <p className="text-xs text-zinc-500">O teu capataz virtual</p>
      </header>

      <main className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {orphanedPending.length > 0 && (
          <section className="rounded-xl border border-zinc-500/20 p-3">
            <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-zinc-500">
              Propostas por decidir
            </div>
            {orphanedPending.map(p => (
              <ProposalCard key={p.proposalId} proposalId={p.proposalId} renderedText={p.renderedText} />
            ))}
          </section>
        )}
        {messages.length === 0 && (
          <p className="pt-10 text-center text-sm text-zinc-500">
            Fala com o Capo — ele trata das obras, das tarefas e da equipa.
          </p>
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
                    markdown={message.role === 'assistant'}
                  />
                ))}
              </div>
            </div>
          ),
        )}
        {busy && (
          <div className="flex items-center gap-3 text-xs text-zinc-500">
            <span>O Capo está a escrever…</span>
            <button type="button" onClick={stop} className="underline hover:text-zinc-400">
              Parar
            </button>
          </div>
        )}
        {/* Before this, a 402 (subscrição expirada) or a 500 left the manager
            staring at a message that never got an answer, with nothing to act
            on. Silence is the worst possible failure mode for a chat product. */}
        {error && (
          <div className="rounded-xl border border-red-500/50 bg-red-500/10 p-3 text-sm">
            <p className="font-medium text-red-600 dark:text-red-400">O Capo não conseguiu responder.</p>
            <p className="mt-0.5 text-xs text-zinc-500">{errorHint(error)}</p>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                onClick={retry}
                className="rounded-lg bg-zinc-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-zinc-600"
              >
                Tentar outra vez
              </button>
              <button
                type="button"
                onClick={clearError}
                className="rounded-lg border border-zinc-400 px-3 py-1.5 text-xs font-semibold hover:bg-zinc-500/10"
              >
                Dispensar
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
          placeholder="Escreve, fala, ou cola o orçamento…"
          className="max-h-[33vh] flex-1 resize-none rounded-xl border border-zinc-500/30 bg-transparent px-3 py-2 text-base outline-none focus:border-emerald-600"
        />
        {/* Transcription only fills the input — the manager reviews and sends. */}
        <MicButton
          disabled={busy}
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
          Enviar
        </button>
      </form>
    </div>
  );
}
