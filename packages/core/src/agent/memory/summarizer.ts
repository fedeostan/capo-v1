import { generateText } from 'ai';
import type { Db } from '@capo/db/client';
import type { Locale } from '@capo/i18n/locale';
import { promptBlocks } from '../../i18n';
import { getModel } from '../models';
import { localeName } from '../prompts/language';
import { loadWindow, rowText } from './conversation';

// ── FEDERICO (fidelity/cost dial): when to summarize and how much to keep
// verbatim. 40/10 hits the milestone fast but is aggressive for a real
// WhatsApp thread — tune once there's real usage. ──
export const SUMMARIZE_AFTER = 40; // messages beyond the last summary before a pass runs
export const KEEP_RECENT = 10; // most recent messages always left verbatim

// Runs post-response (the sink has already flushed, so the manager never waits
// on this). Cheap model role; temporally anchored so recall stays dated.
//
// `locale` is the USER locale: the summary is re-read into the system prompt on
// later turns, so it should be in the language Capo is speaking. A thread that
// switched language mid-way gets a summary in the NEW language over older
// content in the old one — acceptable, and self-correcting as the thread moves on.
export async function maybeSummarize(db: Db, conversationId: string, locale: Locale): Promise<void> {
  const window = await loadWindow(db, conversationId);
  if (window.rows.length <= SUMMARIZE_AFTER) return;

  const toSummarize = window.rows.slice(0, window.rows.length - KEEP_RECENT);
  if (toSummarize.length === 0) return;

  const t = promptBlocks[locale];
  const transcript = toSummarize
    .map(row => {
      const day = row.created_at.slice(0, 10);
      const speaker =
        row.role === 'user' ? t.speakers.user : row.role === 'assistant' ? t.speakers.assistant : t.speakers.event;
      const text = rowText(row) || t.emptyMessage;
      return `[${day}] ${speaker}: ${text}`;
    })
    .join('\n');

  // Scaffolding in English (model-facing), output language named explicitly.
  const { text } = await generateText({
    model: getModel('summarizer'),
    system: [
      `You compress a conversation between a construction company manager (${t.speakers.user}) and his AI foreman (Capo).`,
      `Write the summary in ${localeName(locale)}.`,
      'Anchor every fact to its date, e.g. "2026-07-06: created a foundations task for the Rua X job".',
      'Keep: decisions, created/updated tasks and jobs, approvals/rejections, deadlines, preferences, open questions.',
      'Drop: greetings, chit-chat, restatements.',
    ].join('\n'),
    prompt: [
      window.summary ? `Existing summary (merge into this):\n${window.summary}` : null,
      `New messages:\n${transcript}`,
      'Produce the consolidated, updated summary:',
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
