import { generateText } from 'ai';
import type { Db } from '@/src/db/client';
import { getModel } from '../models';
import { loadWindow, rowText } from './conversation';

// ── FEDERICO (fidelity/cost dial): when to summarize and how much to keep
// verbatim. 40/10 hits the milestone fast but is aggressive for a real
// WhatsApp thread — tune once there's real usage. ──
export const SUMMARIZE_AFTER = 40; // messages beyond the last summary before a pass runs
export const KEEP_RECENT = 10; // most recent messages always left verbatim

// Runs post-response (the sink has already flushed, so the manager never waits
// on this). Cheap model role; temporally anchored so recall stays dated.
export async function maybeSummarize(db: Db, conversationId: string): Promise<void> {
  const window = await loadWindow(db, conversationId);
  if (window.rows.length <= SUMMARIZE_AFTER) return;

  const toSummarize = window.rows.slice(0, window.rows.length - KEEP_RECENT);
  if (toSummarize.length === 0) return;

  const transcript = toSummarize
    .map(row => {
      const day = row.created_at.slice(0, 10);
      const speaker = row.role === 'user' ? 'Gerente' : row.role === 'assistant' ? 'Capo' : 'Evento';
      const text = rowText(row) || '(mensagem sem texto)';
      return `[${day}] ${speaker}: ${text}`;
    })
    .join('\n');

  const { text } = await generateText({
    model: getModel('summarizer'),
    system: [
      'You compress a conversation between a construction company manager (Gerente) and his AI foreman (Capo).',
      'Write the summary in European Portuguese.',
      'Anchor every fact to its date, e.g. "2026-07-06: criada tarefa de fundações para a obra da Rua X".',
      'Keep: decisions, created/updated tasks and jobs, approvals/rejections, deadlines, preferences, open questions.',
      'Drop: greetings, chit-chat, restatements.',
    ].join('\n'),
    prompt: [
      window.summary ? `Resumo existente (a fundir):\n${window.summary}` : null,
      `Novas mensagens:\n${transcript}`,
      'Produz o resumo consolidado e atualizado:',
    ]
      .filter(Boolean)
      .join('\n\n'),
  });

  const { error } = await db.from('conversation_summaries').insert({
    conversation_id: conversationId,
    summary: text,
    covers_until_message_id: toSummarize[toSummarize.length - 1].id,
  });
  if (error) throw new Error(`Failed to store summary: ${error.message}`);
}
