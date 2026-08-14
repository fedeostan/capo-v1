import { generateText } from 'ai';
import type { Db } from '@capo/db/client';
import type { Locale } from '@capo/i18n/locale';
import { promptBlocks } from '../../i18n';
import { getModel } from '../models';
import { localeName } from '../prompts/language';
import { loadWindow, rowText } from './conversation';

// ── FEDERICO (fidelity/cost dial): when to summarize and how much to keep
// verbatim. TUNED from 40/10 to 80/30 for issue #48 — the old comment here said
// "40/10 hits the milestone fast but is aggressive for a real WhatsApp thread,
// tune once there's real usage", and there is real usage now. Three reasons, in
// descending order of how much they matter:
//
//   1. EVERY PASS IS A PHOTOCOPY OF A PHOTOCOPY. Each summary is written by
//      MERGING into the previous one (see the prompt below), so a distortion
//      introduced once is re-copied for ever. Issue #62 is the worked example:
//      the manager's old surname survived months of merges and was read back
//      into every turn. Passes per N messages is N / (SUMMARIZE_AFTER -
//      KEEP_RECENT), so 40/10 → 80/30 takes it from N/30 to N/50: about 40%
//      fewer generations of loss over the same conversation.
//   2. THE THREAD IS NO LONGER ONLY THE MANAGER. Since #47 the system writes
//      role='event' rows into `messages` — what the morning briefing said, who
//      the check-in asked, who answered — several a day, none of them typed by
//      anybody. At 40 a pass can now fire on a week in which the manager said
//      almost nothing, i.e. we pay a model to compress our own status notes.
//   3. TEN MESSAGES IS LESS THAN ONE CONVERSATION. The verbatim tail is the
//      part the model reads exactly rather than as a memory of a memory; 30 is
//      about one sitting.
//
// THE COST, STATED: the verbatim tail is re-sent on every request and the
// conversation history carries NO cache breakpoint (#58, known and not done),
// while `stopWhen(12)` means one inbound message can be twelve requests. Roughly
// doubling the tail roughly doubles that part of a heavy turn's bill. It is
// affordable now because #48 captures durable facts as structured MEMORIES
// instead of leaning on summary prose to hold them — and `ai_usage` (#53) will
// show it within days if that judgement is wrong.
//
// The two numbers are exported and this is the only place they live: retuning
// is one edit.
export const SUMMARIZE_AFTER = 80; // messages beyond the last summary before a pass runs
export const KEEP_RECENT = 30; // most recent messages always left verbatim

// Runs post-response (the sink has already flushed, so the manager never waits
// on this). Cheap model role; temporally anchored so recall stays dated.
//
// `locale` is the USER locale: the summary is re-read into the system prompt on
// later turns, so it should be in the language Capo is speaking. A thread that
// switched language mid-way gets a summary in the NEW language over older
// content in the old one — acceptable, and self-correcting as the thread moves on.
export async function maybeSummarize(
  db: Db,
  conversationId: string,
  locale: Locale,
  // Whose token spend this is (issue #53). A separate parameter rather than a
  // widened `db` argument, and required: this function is called from exactly
  // one place, which already knows both ids, so there is no case where the
  // honest answer is "unattributed".
  usage: { companyId: string; profileId: string },
): Promise<void> {
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
    model: getModel('summarizer', {
      db,
      companyId: usage.companyId,
      surface: 'summarizer',
      actor: { kind: 'manager', profileId: usage.profileId },
    }),
    system: [
      `You compress a conversation between a construction company manager (${t.speakers.user}) and his AI foreman (Capo).`,
      `Write the summary in ${localeName(locale)}.`,
      'Anchor every fact to its date, e.g. "2026-07-06: created a foundations task for the Rua X job".',
      'Keep: decisions, created/updated tasks and jobs, approvals/rejections, deadlines, preferences, open questions.',
      'Drop: greetings, chit-chat, restatements.',
      // Issue #62: the summary is injected into every later system prompt, and
      // each pass MERGES the previous one — so anything written here is copied
      // forward indefinitely. The manager's name is a database row he can
      // change from Profile at any time; once frozen into this prose it goes
      // stale silently and is then re-read on every turn for months. Naming him
      // by role instead costs the summary nothing (there is exactly one manager
      // per conversation) and makes each pass launder an older name out.
      `Never write the manager's own name — call him "${t.speakers.user}", including when merging an existing summary that used his name. His name is live data that can change; a summary that hard-codes it goes stale silently.`,
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
