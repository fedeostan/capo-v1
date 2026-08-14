import { generateText } from 'ai';
import type { Db } from '@capo/db/client';
import type { Locale } from '@capo/i18n/locale';
import { getModel } from './models';
import { managerOrSystem } from './usage';

// Speech → text, shared by the web mic button and inbound WhatsApp voice notes.
//
// Lives in @capo/core rather than in the route it came from because the
// WhatsApp webhook cannot reach a session-gated API route. Takes (db, companyId)
// rather than an AuthContext for the same structural reason @capo/core imports
// only TYPES from @capo/db: @capo/db/session pulls in next/navigation, and this
// package must stay runnable from a plain script.

// Browsers record ≤60s of compressed audio and Meta caps inbound audio at
// 16 MiB; anything near this limit is not a voice note gone long, it's a wrong
// payload. Shared by both callers so the two paths cannot drift.
export const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

export interface TranscriptionVocabulary {
  workerNames: string[];
  jobNames: string[];
  learnedTerms: string[];
}

const EMPTY_VOCABULARY: TranscriptionVocabulary = { workerNames: [], jobNames: [], learnedTerms: [] };

interface TranscriptionCopy {
  languageLine: string;
  onlyTextLine: string;
  emptyLine: string;
  contextLine: string;
  /** ── FEDERICO (the steering dial): the construction vocabulary each locale's
   *  crews actually use. This is the single highest-leverage string for
   *  transcription accuracy — a term listed here gets recognised, a term missing
   *  gets mangled into a homophone. Tune per market. ── */
  glossaryLine: string;
  workerNames(list: string): string;
  jobNames(list: string): string;
  learnedTerms(list: string): string;
}

const copy: Record<Locale, TranscriptionCopy> = {
  'pt-PT': {
    languageLine: 'Transcreve o áudio seguinte em português europeu (pt-PT), nunca em português do Brasil.',
    onlyTextLine: 'Devolve apenas o texto transcrito, sem comentários, sem pontuação a mais, sem traduções.',
    emptyLine: 'Se não houver fala percetível, devolve uma resposta vazia.',
    contextLine: 'Contexto: um encarregado de uma empresa de construção civil a ditar ordens e notas de obra.',
    glossaryLine:
      'Vocabulário provável: obra, tarefa, demolição, betão, cofragem, alvenaria, estaleiro, empreitada, roços, betonilha, azulejo, andaime.',
    workerNames: list => `Nomes prováveis de trabalhadores: ${list}.`,
    jobNames: list => `Nomes prováveis de obras: ${list}.`,
    learnedTerms: list => `Termos e nomes que este encarregado costuma usar: ${list}.`,
  },
  'es-ES': {
    languageLine: 'Transcribe el audio siguiente en español de España (es-ES), nunca en español latinoamericano.',
    onlyTextLine: 'Devuelve solo el texto transcrito, sin comentarios, sin puntuación de más, sin traducciones.',
    emptyLine: 'Si no hay habla perceptible, devuelve una respuesta vacía.',
    contextLine: 'Contexto: un encargado de una empresa de construcción dictando órdenes y notas de obra.',
    glossaryLine:
      'Vocabulario probable: obra, tarea, demolición, hormigón, encofrado, albañilería, tabique, alicatado, andamio, fontanería, rozas, solera.',
    workerNames: list => `Nombres probables de trabajadores: ${list}.`,
    jobNames: list => `Nombres probables de obras: ${list}.`,
    learnedTerms: list => `Términos y nombres que este encargado suele usar: ${list}.`,
  },
  'en-US': {
    languageLine: 'Transcribe the following audio in American English (en-US).',
    onlyTextLine: 'Return only the transcribed text — no commentary, no added punctuation, no translation.',
    emptyLine: 'If there is no discernible speech, return an empty response.',
    contextLine: 'Context: a construction foreman dictating orders and jobsite notes.',
    glossaryLine:
      'Likely vocabulary: job, task, demo, concrete, formwork, rebar, framing, drywall, screed, tile, scaffold, rough-in, punch list.',
    workerNames: list => `Likely worker names: ${list}.`,
    jobNames: list => `Likely job names: ${list}.`,
    learnedTerms: list => `Terms and names this foreman tends to use: ${list}.`,
  },
};

export function buildTranscriptionInstruction(locale: Locale, vocab: TranscriptionVocabulary): string {
  const t = copy[locale];
  const lines = [t.languageLine, t.onlyTextLine, t.emptyLine, t.contextLine, t.glossaryLine];
  // Names are proper nouns: they come from the DB in the COMPANY language while
  // the speech is in the USER language. Injecting them regardless is correct —
  // a Portuguese job name is still what an English-speaking foreman says out loud.
  if (vocab.workerNames.length) lines.push(t.workerNames(vocab.workerNames.join(', ')));
  if (vocab.jobNames.length) lines.push(t.jobNames(vocab.jobNames.join(', ')));
  if (vocab.learnedTerms.length) lines.push(t.learnedTerms(vocab.learnedTerms.join(', ')));
  return lines.join('\n');
}

export async function fetchTranscriptionVocabulary(db: Db, companyId: string): Promise<TranscriptionVocabulary> {
  const [workers, jobs, learned] = await Promise.all([
    db.from('workers').select('name').eq('company_id', companyId).limit(50),
    db.from('jobs').select('name').eq('company_id', companyId).limit(50),
    // Self-learned corrections: reinforced terms rank first, so bad learnings
    // sink out of the top 40 on their own.
    db
      .from('transcription_vocab')
      .select('term')
      .eq('company_id', companyId)
      .order('weight', { ascending: false })
      .order('last_reinforced_at', { ascending: false })
      .limit(40),
  ]);
  return {
    workerNames: (workers.data ?? []).map(w => w.name),
    jobNames: (jobs.data ?? []).map(j => j.name),
    learnedTerms: (learned.data ?? []).map(t => t.term),
  };
}

export interface TranscribeAudioInput {
  db: Db;
  companyId: string;
  /** The USER dial — how the person speaking actually talks. */
  locale: Locale;
  audio: Uint8Array;
  /** Bare MIME type, no parameters. WhatsApp voice notes arrive as
   *  "audio/ogg; codecs=opus" and MUST be stripped to "audio/ogg" first. */
  mediaType: string;
  /**
   * profiles.id of whoever spoke, for the token ledger (issue #53). Both
   * callers are manager paths — the web mic button and a manager's inbound
   * WhatsApp voice note — and a crew member never reaches here, because the
   * worker loop takes text and images only.
   *
   * Nullable rather than required so a future caller without a session records
   * the spend against the company instead of being unable to record it at all.
   */
  profileId?: string | null;
}

/** Returns the trimmed transcript, or '' when there was no discernible speech. */
export async function transcribeAudio(input: TranscribeAudioInput): Promise<string> {
  // Vocabulary is best-effort: a transcription without name hints beats a 500.
  const vocab = await fetchTranscriptionVocabulary(input.db, input.companyId).catch(() => EMPTY_VOCABULARY);

  const { text } = await generateText({
    model: getModel('transcription', {
      db: input.db,
      companyId: input.companyId,
      surface: 'transcription',
      actor: managerOrSystem(input.profileId),
    }),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: buildTranscriptionInstruction(input.locale, vocab) },
          { type: 'file', mediaType: input.mediaType, data: input.audio },
        ],
      },
    ],
  });

  return text.trim();
}
