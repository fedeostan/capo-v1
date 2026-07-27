import { generateObject } from 'ai';
import { z } from 'zod';
import type { Locale } from '@capo/i18n/locale';
import { getModel } from '../agent/models';
import { buildTranslatorPrompt } from './prompt';

// The model call, and the validation that makes its output safe to write.

const chunkSchema = z.object({
  items: z.array(z.object({ id: z.number().int(), text: z.string() })),
});

// Whichever comes first. 40 short titles is a comfortable single call; the
// character cap is what stops 40 long task descriptions from being one.
const MAX_ITEMS_PER_CALL = 40;
const MAX_CHARS_PER_CALL = 4000;
const CONCURRENCY = 3;

/** Split into calls, preserving each string's index in the original array. */
function chunk(strings: string[]): number[][] {
  const chunks: number[][] = [];
  let current: number[] = [];
  let chars = 0;

  for (let i = 0; i < strings.length; i++) {
    const len = strings[i].length;
    if (current.length > 0 && (current.length >= MAX_ITEMS_PER_CALL || chars + len > MAX_CHARS_PER_CALL)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(i);
    chars += len;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * One call. Returns translations positionally aligned with `strings`, or throws.
 *
 * The id check is the highest-value defensive line in the whole feature. The
 * failure it prevents is silent: if the model drops or reorders one item and we
 * zip the response by position, every translation after it lands on the WRONG
 * ROW. The snapshot would faithfully record that mis-assignment as intended, so
 * undo restores it correctly and nothing ever surfaces an error — the manager
 * just finds, weeks later, that a task is describing someone else's work.
 * NEVER relax this into a length check plus positional zip.
 */
async function translateOnce(strings: string[], system: string): Promise<string[]> {
  const { object } = await generateObject({
    model: getModel('translation'),
    schema: chunkSchema,
    system,
    prompt: JSON.stringify({ items: strings.map((text, id) => ({ id, text })) }),
  });

  const byId = new Map(object.items.map(i => [i.id, i.text]));
  if (byId.size !== strings.length) {
    throw new Error(`Translator returned ${byId.size} unique ids for ${strings.length} inputs`);
  }
  return strings.map((_, id) => {
    const text = byId.get(id);
    if (text === undefined) throw new Error(`Translator omitted id ${id}`);
    return text;
  });
}

/**
 * Translate a flat list of strings.
 *
 * Never throws for a content reason: a string the model could not handle comes
 * back as null and its item is marked failed, so one bad title cannot abandon
 * the other 499. Genuine infrastructure failures (bad key, provider down) do
 * throw, and the caller marks the whole batch failed and resumable.
 */
export async function translateStrings(
  strings: string[],
  from: Locale,
  to: Locale,
  glossary: string[],
): Promise<(string | null)[]> {
  if (strings.length === 0) return [];
  const system = buildTranslatorPrompt(from, to, glossary);
  const out: (string | null)[] = new Array(strings.length).fill(null);
  const chunks = chunk(strings);

  async function runChunk(indices: number[]): Promise<void> {
    const inputs = indices.map(i => strings[i]);
    let results: (string | null)[];

    try {
      results = await translateOnce(inputs, system);
    } catch {
      // Retry the chunk once — a malformed object is usually transient.
      try {
        results = await translateOnce(inputs, system);
      } catch {
        // Fall back to one call per string. Slow, but a single string cannot be
        // mis-numbered against itself, so this always converges to either a
        // translation or an honest null.
        results = await Promise.all(
          inputs.map(async s => {
            try {
              return (await translateOnce([s], system))[0];
            } catch {
              return null;
            }
          }),
        );
      }
    }

    indices.forEach((target, k) => {
      out[target] = results[k];
    });
  }

  // Enough in flight to hide per-call latency, few enough not to trip rate
  // limits on a key shared with the conversation model.
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, async () => {
      while (next < chunks.length) {
        await runChunk(chunks[next++]);
      }
    }),
  );

  return out;
}
