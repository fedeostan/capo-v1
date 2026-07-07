import type { UIMessage } from 'ai';
import type { Db } from '@/src/db/client';
import type { Json, Tables } from '@/src/db/types';

// Memory tier 1: the conversational/episodic thread. One perpetual thread per
// company, shared across channels — channel is a message attribute.

// companyId always arrives from the caller's resolved identity (requireAuth /
// getApiAuth) — never from "first company". No module-scope caching: a warm
// serverless instance is shared across tenants, so anything cached here would
// leak one company's thread to another.

// Read-only lookup for render paths (the chat page must never write).
export async function findConversation(db: Db, companyId: string): Promise<string | null> {
  const { data } = await db
    .from('conversations')
    .select('id')
    .eq('company_id', companyId)
    .order('created_at')
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

// Find-or-create for the write path (first inbound message of a company).
export async function ensureConversation(db: Db, companyId: string): Promise<string> {
  const existing = await findConversation(db, companyId);
  if (existing) return existing;
  const { data, error } = await db.from('conversations').insert({ company_id: companyId }).select('id').single();
  if (error) throw new Error(`Failed to create conversation: ${error.message}`);
  return data.id;
}

type MessageRow = Tables<'messages'>;

const CONTENT_FORMAT = 'ui-message@7';

export async function persistUserMessage(db: Db, conversationId: string, text: string, channel: string): Promise<void> {
  const { error } = await db.from('messages').insert({
    conversation_id: conversationId,
    role: 'user',
    channel,
    content: { parts: [{ type: 'text', text }] },
    content_format: CONTENT_FORMAT,
  });
  if (error) throw new Error(`Failed to persist user message: ${error.message}`);
}

export async function persistAssistantMessage(
  db: Db,
  conversationId: string,
  message: UIMessage,
  channel: string,
): Promise<void> {
  const { error } = await db.from('messages').insert({
    conversation_id: conversationId,
    role: 'assistant',
    channel,
    content: { parts: message.parts } as unknown as Json,
    content_format: CONTENT_FORMAT,
  });
  if (error) throw new Error(`Failed to persist assistant message: ${error.message}`);
}

// role='event' is first-class: proposal resolutions etc. are system events,
// never conflated with something the manager said.
export async function appendEventMessage(db: Db, conversationId: string, text: string): Promise<void> {
  const { error } = await db.from('messages').insert({
    conversation_id: conversationId,
    role: 'event',
    channel: 'system',
    content: { parts: [{ type: 'text', text }] },
    content_format: CONTENT_FORMAT,
  });
  if (error) throw new Error(`Failed to persist event message: ${error.message}`);
}

export interface ThreadWindow {
  summary: string | null;
  rows: MessageRow[];
}

// Everything after the latest summary watermark (or the whole thread if no
// summary exists yet). Shared by context building and the summarizer.
export async function loadWindow(db: Db, conversationId: string): Promise<ThreadWindow> {
  const { data: summaryRow } = await db
    .from('conversation_summaries')
    .select('summary, covers_until_message_id')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  let query = db
    .from('messages')
    .select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .limit(500);

  if (summaryRow) {
    const { data: watermark } = await db
      .from('messages')
      .select('created_at')
      .eq('id', summaryRow.covers_until_message_id)
      .single();
    if (watermark) query = query.gt('created_at', watermark.created_at);
  }

  const { data: rows, error } = await query;
  if (error) throw new Error(`Failed to load thread: ${error.message}`);
  return { summary: summaryRow?.summary ?? null, rows: rows ?? [] };
}

export function rowText(row: MessageRow): string {
  const content = row.content as { parts?: Array<{ type: string; text?: string }> } | null;
  return (content?.parts ?? [])
    .filter(p => p.type === 'text' && p.text)
    .map(p => p.text)
    .join('\n');
}

export interface Thread {
  summary: string | null;
  uiMessages: UIMessage[];
  recentUserTexts: string[];
}

export function toThread(window: ThreadWindow): Thread {
  const uiMessages: UIMessage[] = window.rows.map(row => {
    const content = row.content as { parts?: UIMessage['parts'] } | null;
    if (row.role === 'event') {
      // Presented to the model as a tagged user-channel notice (model messages
      // only support system/user/assistant); the orchestration policy explains
      // that <system-event> is not the manager. The DB taxonomy stays clean.
      return {
        id: row.id,
        role: 'user',
        parts: [{ type: 'text', text: `<system-event>${rowText(row)}</system-event>` }],
      };
    }
    return {
      id: row.id,
      role: row.role as 'user' | 'assistant',
      parts: content?.parts ?? [],
    };
  });

  const recentUserTexts = window.rows
    .filter(r => r.role === 'user')
    .slice(-3)
    .map(rowText);

  return { summary: window.summary, uiMessages, recentUserTexts };
}
