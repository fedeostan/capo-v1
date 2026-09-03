import type { Db } from '@capo/db/client';
import type { Locale } from '@capo/i18n/locale';
import { MAX_AUDIO_BYTES, transcribeAudio, type VocabularyScope } from '@capo/core/transcription';
import { downloadMedia } from '@capo/core/channels/whatsapp-media';

// A CREW MEMBER's voice note, turned into the text they would have typed.
//
// ── WHY THIS REVERSES A WRITTEN-DOWN DECISION ──────────────────────────────
// PRD 4 said this out loud in apps/web/app/api/whatsapp/route.ts: "a voice note
// from a worker is deliberately NOT transcribed here". The reason given was
// cost, one extra model call per message against a daily budget, and it was a
// fair trade for a path that PRD did not cover. It is not a fair trade now.
// People on a building site talk far more than they type, often with one hand
// and gloves on, and what they got for a voice note was the generic
// acknowledgement written for a sticker. Silence dressed as politeness.
//
// ── THE COST IS BOUNDED BY THE BUDGET, AND THAT IS STRUCTURAL ──────────────
// `transcribeWorkerAudio` is NOT called by the route directly. It is handed to
// `handleWorkerInbound` as a callback and invoked there, BELOW the daily budget
// read and above everything else, so a crew member whose cap is already spent
// pays for no download and no Gemini call - the property worker-core.ts has
// always claimed and which an eager transcription in the route would have
// quietly broken. See `inbound.transcribe` in packages/core/src/agent/worker-core.ts.
//
// A transcription that FAILS still consumes one unit of that budget: the turn
// persists a short marker line of OUR OWN copy in place of the transcript.
// Otherwise a failing voice note is free forever, and "free forever" plus
// "attacker chooses how often it arrives" is the cost amplifier the cap exists
// to prevent. The other bound is MAX_AUDIO_BYTES below.
//
// ── WHAT A TRANSCRIPT IS, AND IS NOT ───────────────────────────────────────
// It is worker-authored text. It lands in `worker_messages` exactly as a typed
// message does, and NOWHERE else: never `messages`, never a summary, never a
// memory, never a proposal (0027, AGENTS.md).
//
// It is NOT a tap and it is NOT a keyword. The five deterministic keyword
// tables (STOP/START, the report keyword, PT/ES/EN, MENU, OK) all sit ABOVE the
// agent branch and all of them read `message.type === 'text'`, so none of them
// runs on a transcript. That is deliberate rather than incidental: those tables
// exist so a MODEL can never intercept a tap, and a transcript is already model
// output. Somebody saying "stop" into a microphone reaches the agent, which
// answers them; the written STOP is still the unsubscribe, and it is the one
// Meta requires and the one the 07:00 message names.
//
// Everything above `transcribeWorkerAudio` is pure and takes no clock, no
// network and no Db, which is what lets `pnpm whatsapp-check` pin it.

/**
 * NO VOCABULARY, and this is a boundary rather than a tuning choice.
 *
 * The manager paths steer Gemini with their own company's crew names, obra
 * names and learned terms, which is the single biggest lever on accuracy. The
 * worker path may not: the crew prompt is built around giving a worker nothing
 * that names another crew member, another task or the company's shape, and the
 * audio here is chosen by whoever holds the phone. Putting the roster one
 * prompt line away from an attacker-chosen payload would move that boundary
 * from the type system into a sentence, which this repository does not do.
 *
 * Named as a constant rather than written inline at the call site so
 * `pnpm whatsapp-check` has something to assert about it.
 */
export const WORKER_VOCABULARY_SCOPE: VocabularyScope = 'none';

/**
 * The size cap is the MANAGER path's, deliberately the same constant rather
 * than a worker-specific one.
 *
 * Meta caps inbound audio at 16 MiB, so anything near this is not a voice note
 * that ran long, it is a wrong payload. Two numbers would eventually disagree,
 * and the symptom would be a crew member's voice note refused at a size a
 * manager's is accepted at, with nothing saying why.
 */
export const WORKER_AUDIO_MAX_BYTES = MAX_AUDIO_BYTES;

/**
 * A transcript this short is not a short message, it is a failed one.
 *
 * Gemini returns an empty string for silence, but a noisy site recording can
 * also come back as a single stray character. Both cases mean the same thing to
 * the person who recorded it: say it again, or write it. The floor is 2 so a
 * genuine "ok" or "sim" still gets through, and at least one letter or digit is
 * required so a lone "?" or "..." does not buy a model turn.
 */
export const MIN_WORKER_TRANSCRIPT_CHARS = 2;

const ALPHANUMERIC = /[\p{L}\p{N}]/u;

/**
 * Is this inbound message a voice note we can actually fetch?
 *
 * WhatsApp has ONE audio type. `audio.voice === true` is push-to-talk and
 * `false`/absent is an uploaded file, and both are accepted here for the reason
 * the manager path accepts both: refusing somebody's own recording of
 * themselves talking would be user-hostile, and the two are indistinguishable
 * to everything downstream. A message with no media id is one Meta can send and
 * nothing can be downloaded from, so it is not audio for our purposes.
 */
export function isWorkerAudioMessage<M extends { type: string; audio?: { id: string; voice?: boolean } }>(
  message: M,
): message is M & { audio: { id: string; voice?: boolean } } {
  return message.type === 'audio' && !!message.audio?.id;
}

/**
 * The transcript, trimmed, or null when there is nothing usable in it.
 *
 * A single rule in a single place, so the "empty" and the "too short" cases
 * cannot drift apart into two different answers to the crew member.
 */
export function usableTranscript(raw: string | null | undefined): string | null {
  const text = (raw ?? '').trim();
  if (text.length < MIN_WORKER_TRANSCRIPT_CHARS) return null;
  if (!ALPHANUMERIC.test(text)) return null;
  return text;
}

/** Why a voice note produced no text. Logged, never shown to the crew member:
 *  they can do exactly one thing about any of them, and it is the same thing. */
export type WorkerAudioFailure = 'download' | 'transcribe' | 'empty';

export type WorkerAudioResult =
  | { ok: true; text: string }
  | { ok: false; reason: WorkerAudioFailure; error?: string };

export interface TranscribeWorkerAudioInput {
  /** ALWAYS the service role. There is no session on the webhook path. */
  db: Db;
  companyId: string;
  workerId: string;
  /** The WORKER's own dial: `workers.language ?? companies.language`. This is
   *  the language they actually speak, so it is the one that steers the
   *  transcription. */
  locale: Locale;
  mediaId: string;
  accessToken: string;
}

/**
 * Download, transcribe, and say plainly whether there is anything to answer.
 *
 * Never throws: every failure is a `{ ok: false }` the caller turns into one
 * honest line. A voice note that silently produced nothing is the bug this
 * function exists to end, so it must not be able to reintroduce it by
 * exploding on the way.
 *
 * ⚠ CALL IT ONLY FROM BELOW THE BUDGET READ. It is passed to
 * `handleWorkerInbound` as `inbound.transcribe` precisely so the one place that
 * knows whether this crew member may spend anything today is the one place that
 * decides whether this runs. Calling it from the route again would restore the
 * unmetered path this shape exists to close.
 *
 * ── THE LEDGER LINE ─────────────────────────────────────────────────────────
 * The spend is filed against `{ kind: 'worker', workerId }` on surface
 * `worker_chat`: a crew member's message cost this, and it is part of what
 * talking to the crew costs. It is NOT filed as `transcription`, which on the
 * /cost dashboard is the manager's dictation, and it can never be filed against
 * a profile because `UsageActor` has no shape that would carry one.
 */
export async function transcribeWorkerAudio(input: TranscribeWorkerAudioInput): Promise<WorkerAudioResult> {
  let audio: { bytes: Uint8Array; mediaType: string };
  try {
    // Meta's media URL is short-lived (~5 minutes) and single-use, so the
    // download happens here and now. Nothing is stored and nothing is retried.
    audio = await downloadMedia(input.mediaId, {
      accessToken: input.accessToken,
      maxBytes: WORKER_AUDIO_MAX_BYTES,
    });
  } catch (err) {
    return { ok: false, reason: 'download', error: err instanceof Error ? err.message : String(err) };
  }

  let raw: string;
  try {
    raw = await transcribeAudio({
      db: input.db,
      companyId: input.companyId,
      locale: input.locale,
      audio: audio.bytes,
      mediaType: audio.mediaType,
      usage: { actor: { kind: 'worker', workerId: input.workerId }, surface: 'worker_chat' },
      vocabulary: WORKER_VOCABULARY_SCOPE,
    });
  } catch (err) {
    return { ok: false, reason: 'transcribe', error: err instanceof Error ? err.message : String(err) };
  }

  const text = usableTranscript(raw);
  if (!text) return { ok: false, reason: 'empty' };
  return { ok: true, text };
}
