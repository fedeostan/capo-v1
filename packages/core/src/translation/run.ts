import type { Db } from '@capo/db/client';
import type { Locale } from '@capo/i18n/locale';
import { collectTranslatable, loadGlossary } from './collect';
import { translateStrings } from './translate';

// Batch lifecycle. Deliberately free of any Next.js import: the app layer owns
// after()/maxDuration, this owns "process pending items until done or out of
// budget" and nothing else.

/** Items pulled, translated and written per wave. Bounds memory and gives the
 *  budget check somewhere to land, so a batch can stop cleanly mid-run. */
const WAVE_ITEMS = 60;
const ITEM_INSERT_PAGE = 500;

export class ActiveBatchError extends Error {}

export type BatchStatus = {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'reverted';
  done: number;
  total: number;
  fromLocale: Locale;
  toLocale: Locale;
};

type ItemRow = {
  id: string;
  table_name: string;
  column_name: string;
  row_id: string;
  old_value: unknown;
};

// ── creating ───────────────────────────────────────────────────────────────

/**
 * Snapshot the tenant and hand back a batch ready to run.
 *
 * Does NO model work — it is called from a server action and from a proposal
 * approval, neither of which has the duration budget for hundreds of calls.
 *
 * The company dial flips BEFORE the snapshot is collected, and the order
 * matters. Flipping first means any row Capo writes while the batch runs is
 * already in the target language; the worst case is a row collected and then
 * "translated" from the target language into itself, which the translator
 * prompt handles by returning it unchanged. Collecting first would leave those
 * rows written in the OLD language and never queued — permanently stale, which
 * is the exact failure this feature exists to remove.
 */
export async function createTranslationBatch(opts: {
  db: Db;
  companyId: string;
  userId: string | null;
  from: Locale;
  to: Locale;
  origin: 'web' | 'chat';
}): Promise<{ batchId: string; itemCount: number }> {
  const { db, companyId, userId, from, to, origin } = opts;
  if (from === to) throw new Error('Company data is already in that language.');

  const { data: batch, error } = await db
    .from('translation_batches')
    .insert({
      company_id: companyId,
      from_locale: from,
      to_locale: to,
      origin,
      created_by: userId,
      status: 'running',
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error) {
    // translation_batches_one_active_idx: one live batch per tenant. Two tabs,
    // a double-submitted form, or a manager toggling the dial repeatedly all
    // land here rather than starting a second concurrent rewrite.
    if (error.code === '23505') {
      throw new ActiveBatchError('A translation is already running for this company.');
    }
    throw new Error(`Failed to create translation batch: ${error.message}`);
  }

  const batchId = batch.id;

  const { error: dialError } = await db.from('companies').update({ language: to }).eq('id', companyId);
  if (dialError) throw new Error(`Failed to switch company language: ${dialError.message}`);

  const collected = await collectTranslatable(db, companyId);

  for (let i = 0; i < collected.length; i += ITEM_INSERT_PAGE) {
    const rows = collected.slice(i, i + ITEM_INSERT_PAGE).map(c => ({
      batch_id: batchId,
      company_id: companyId,
      table_name: c.table,
      row_id: c.rowId,
      column_name: c.column,
      old_value: c.oldValue,
    }));
    const { error: itemError } = await db.from('translation_items').insert(rows);
    if (itemError) throw new Error(`Failed to snapshot rows for translation: ${itemError.message}`);
  }

  await db
    .from('translation_batches')
    .update({
      item_count: collected.length,
      // An empty tenant has nothing to run; leaving it 'running' would hold the
      // one-active-batch lock forever and block the next real switch.
      ...(collected.length === 0
        ? { status: 'completed' as const, finished_at: new Date().toISOString() }
        : {}),
    })
    .eq('id', batchId);

  return { batchId, itemCount: collected.length };
}

// ── running ────────────────────────────────────────────────────────────────

/** Write one translated value back, but only if the row still holds exactly
 *  what this batch snapshotted. A manager who hand-edited a title mid-batch
 *  keeps their edit, and the item is reported skipped rather than applied. */
async function writeValue(
  db: Db,
  companyId: string,
  item: ItemRow,
  oldValue: unknown,
  next: string | string[],
): Promise<boolean> {
  const id = item.row_id;

  // tasks.materials is the only text[] in scope. PostgREST array equality in a
  // filter is fragile enough that a read-then-write is the honest option here;
  // the race window is one round trip and loses to a concurrent edit by
  // overwriting it, which is documented rather than fixed.
  if (item.column_name === 'materials') {
    const { data: current } = await db.from('tasks').select('materials').eq('id', id).eq('company_id', companyId).maybeSingle();
    if (!current || JSON.stringify(current.materials ?? []) !== JSON.stringify(oldValue)) return false;
    const { error } = await db
      .from('tasks')
      .update({ materials: next as string[], updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('company_id', companyId);
    if (error) throw new Error(`Failed to write materials: ${error.message}`);
    return true;
  }

  const old = oldValue as string;
  const value = next as string;
  const now = new Date().toISOString();

  // Written out per field rather than with a dynamic key so the generated
  // Database types actually check the column exists on that table — the same
  // six-pair allowlist the migration's CHECK constraint encodes.
  const run = async (): Promise<{ data: { id: string }[] | null; error: { message: string } | null }> => {
    switch (`${item.table_name}.${item.column_name}`) {
      case 'tasks.title':
        return db.from('tasks').update({ title: value, updated_at: now }).eq('id', id).eq('company_id', companyId).eq('title', old).select('id');
      case 'tasks.description':
        return db.from('tasks').update({ description: value, updated_at: now }).eq('id', id).eq('company_id', companyId).eq('description', old).select('id');
      case 'jobs.name':
        return db.from('jobs').update({ name: value }).eq('id', id).eq('company_id', companyId).eq('name', old).select('id');
      case 'workers.trade':
        return db.from('workers').update({ trade: value }).eq('id', id).eq('company_id', companyId).eq('trade', old).select('id');
      case 'memories.content':
        return db.from('memories').update({ content: value, updated_at: now }).eq('id', id).eq('company_id', companyId).eq('content', old).select('id');
      default:
        throw new Error(`Untranslatable field reached writeValue: ${item.table_name}.${item.column_name}`);
    }
  };

  const { data, error } = await run();
  if (error) throw new Error(`Failed to write translation: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

/**
 * Process pending items until the batch is done or the time budget runs out.
 *
 * Start and resume are the SAME call — there is no separate resume path to rot.
 * A batch that runs out of budget, or whose function is killed, simply keeps
 * status 'running' with its remaining items still 'pending'.
 */
export async function runTranslationBatch(
  db: Db,
  batchId: string,
  opts: { budgetMs: number },
): Promise<BatchStatus> {
  const deadline = Date.now() + opts.budgetMs;

  const { data: batch, error } = await db
    .from('translation_batches')
    .select('id, company_id, from_locale, to_locale, status, item_count, done_count')
    .eq('id', batchId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load translation batch: ${error.message}`);
  if (!batch) throw new Error(`Translation batch not found: ${batchId}`);

  const shape = (status: BatchStatus['status'], done: number): BatchStatus => ({
    id: batchId,
    status,
    done,
    total: batch.item_count,
    fromLocale: batch.from_locale as Locale,
    toLocale: batch.to_locale as Locale,
  });

  // Terminal states are not resumable. 'failed' deliberately is.
  if (batch.status === 'completed' || batch.status === 'reverted') {
    return shape(batch.status, batch.done_count);
  }

  // Claiming the batch can legitimately fail: resuming a FAILED batch after a
  // newer one has been started for the same company collides with
  // translation_batches_one_active_idx. Silently ignoring that would leave this
  // run writing translations while the row still says 'failed', and the final
  // 'completed' update would be swallowed too — a batch that looks stuck
  // forever while actually having done the work.
  const { error: claimError } = await db
    .from('translation_batches')
    .update({ status: 'running', error: null, started_at: new Date().toISOString() })
    .eq('id', batchId);
  if (claimError) throw new Error(`Failed to claim translation batch: ${claimError.message}`);

  const glossary = await loadGlossary(db, batch.company_id);
  let done = batch.done_count;

  try {
    for (;;) {
      const { data: items, error: itemError } = await db
        .from('translation_items')
        .select('id, table_name, column_name, row_id, old_value')
        .eq('batch_id', batchId)
        .eq('status', 'pending')
        .order('id')
        .limit(WAVE_ITEMS);
      if (itemError) throw new Error(`Failed to load translation items: ${itemError.message}`);
      if (!items || items.length === 0) break;

      // Flatten to one model unit per string: a materials array of six entries
      // is ONE item (the undo unit) but SIX units (the translation unit). This
      // is what keeps the array's shape safe — it is never round-tripped
      // through the model as a joined string.
      const units: string[] = [];
      const spans = (items as ItemRow[]).map(item => {
        const start = units.length;
        const old = item.old_value;
        if (Array.isArray(old)) units.push(...(old as string[]));
        else units.push(old as string);
        return { item, start, length: units.length - start, old };
      });

      const translated = await translateStrings(
        units,
        batch.from_locale as Locale,
        batch.to_locale as Locale,
        glossary,
        // actor 'system' (issue #53): a bulk translation rewrites the whole
        // tenant's stored data, and it can be resumed hours later by a cron-ish
        // retry with no live person in the request at all. Billing it to
        // whoever happened to tap "translate" would put one manager's name on a
        // company-wide job.
        { db, companyId: batch.company_id, surface: 'translation', actor: { kind: 'system' } },
      );

      for (const { item, start, length, old } of spans) {
        const slice = translated.slice(start, start + length);
        let status: 'applied' | 'skipped' | 'failed';
        let newValue: string | string[] | null = null;

        if (slice.some(v => v === null)) {
          // Partial array translations are never written: half a materials list
          // in each language is worse than leaving it alone.
          status = 'failed';
        } else {
          newValue = Array.isArray(old) ? (slice as string[]) : (slice[0] as string);
          // Write the domain row FIRST, then record the item. Dying between the
          // two re-translates and re-writes the same value on resume, which is
          // harmless; the reverse order would lose the write permanently while
          // claiming it succeeded.
          status = (await writeValue(db, batch.company_id, item, old, newValue)) ? 'applied' : 'skipped';
        }

        await db
          .from('translation_items')
          .update({
            status,
            new_value: newValue,
            applied_at: status === 'applied' ? new Date().toISOString() : null,
          })
          .eq('id', item.id);
        done += 1;
      }

      await db.from('translation_batches').update({ done_count: done }).eq('id', batchId);

      if (Date.now() >= deadline) {
        // Out of budget, not out of work. Caller polls and calls us again.
        return shape('running', done);
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.from('translation_batches').update({ status: 'failed', error: message }).eq('id', batchId);
    return shape('failed', done);
  }

  await db
    .from('translation_batches')
    .update({ status: 'completed', done_count: done, finished_at: new Date().toISOString() })
    .eq('id', batchId);
  return shape('completed', done);
}

// ── reading + reverting ────────────────────────────────────────────────────

export async function getBatchStatus(db: Db, batchId: string): Promise<BatchStatus | null> {
  const { data } = await db
    .from('translation_batches')
    .select('id, status, done_count, item_count, from_locale, to_locale')
    .eq('id', batchId)
    .maybeSingle();
  if (!data) return null;
  return {
    id: data.id,
    status: data.status as BatchStatus['status'],
    done: data.done_count,
    total: data.item_count,
    fromLocale: data.from_locale as Locale,
    toLocale: data.to_locale as Locale,
  };
}

/**
 * Undo, delegated wholesale to the security-definer RPC in 0015.
 *
 * Everything real happens in Postgres in one transaction: replaying hundreds of
 * originals through PostgREST could time out halfway, and a half-undone undo is
 * strictly worse than none.
 */
export async function revertTranslationBatch(
  db: Db,
  batchId: string,
): Promise<{ reverted: number; skipped: number }> {
  const { data, error } = await db.rpc('revert_translation_batch', { p_batch: batchId });
  if (error) throw new Error(`Failed to revert translation: ${error.message}`);
  const result = (data ?? {}) as { reverted?: number; skipped?: number };
  return { reverted: result.reverted ?? 0, skipped: result.skipped ?? 0 };
}
