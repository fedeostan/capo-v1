'use client';

import { useChat } from '@ai-sdk/react';
import { getToolName, isToolUIPart, type UIMessage } from 'ai';
import { useEffect, useRef, useState } from 'react';
import Markdown from './markdown';
import MicButton from './mic-button';

const TOOL_LABELS: Record<string, string> = {
  create_task: 'Tarefa criada',
  update_task: 'Tarefa atualizada',
  list_tasks: 'Tarefas consultadas',
  create_job: 'Obra criada',
  list_jobs: 'Obras consultadas',
  add_worker: 'Trabalhador adicionado',
  list_workers: 'Equipa consultada',
  remember: 'Memorizado',
  propose: 'Proposta criada',
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
  const { messages, sendMessage, status } = useChat({ messages: initialMessages });
  const bottomRef = useRef<HTMLDivElement>(null);
  // What the mic inserted this composer round; compared against the sent text
  // so vocab learning only sees genuine transcription corrections.
  const transcriptRef = useRef('');

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const busy = status === 'submitted' || status === 'streaming';

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
    sendMessage({ text });
    setInput('');
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
        {busy && <div className="text-xs text-zinc-500">O Capo está a escrever…</div>}
        <div ref={bottomRef} />
      </main>

      <form onSubmit={handleSubmit} className="flex gap-2 border-t border-zinc-500/20 p-3">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          placeholder="Escreve uma mensagem…"
          className="flex-1 rounded-xl border border-zinc-500/30 bg-transparent px-3 py-2 text-base outline-none focus:border-emerald-600"
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
          className="rounded-xl bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-50"
        >
          Enviar
        </button>
      </form>
    </div>
  );
}
