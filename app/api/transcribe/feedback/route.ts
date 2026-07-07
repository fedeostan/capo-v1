import { generateObject } from 'ai';
import { z } from 'zod';
import { getModel } from '@/src/agent/models';
import { getApiAuth } from '@/src/auth/session';

export const maxDuration = 30;

// Structural caps: however the extraction model misbehaves, at most 10 terms
// of at most 40 chars can enter the vocab (the DB CHECK enforces 40 again).
const termsSchema = z.array(z.string().min(2).max(40)).max(10);

const bodySchema = z.object({
  transcript: z.string().min(1).max(2000),
  final: z.string().min(1).max(2000),
});

// TODO(Federico): the learning dial. This decides what counts as vocabulary
// worth remembering — tune it to your crews (only names? materials? slang?).
function buildExtractionPrompt(transcript: string, final: string): string {
  return [
    'Um encarregado de construção ditou uma mensagem; a transcrição automática foi depois corrigida à mão antes de enviar.',
    'Compara as duas versões e devolve APENAS os nomes próprios e termos de domínio (obras, pessoas, materiais, locais) que a versão enviada corrige em relação ao que foi ouvido.',
    'Ignora reformulações, correções gramaticais e mudanças de pontuação. Na dúvida, devolve uma lista vazia.',
    '',
    `Ouvido: ${transcript}`,
    `Enviado: ${final}`,
  ].join('\n');
}

export async function POST(req: Request) {
  const auth = await getApiAuth();
  if (!auth) return Response.json({ error: 'Não autenticado' }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'Invalid body' }, { status: 400 });
  const { transcript, final } = parsed.data;
  if (transcript.trim() === final.trim()) return Response.json({ learned: 0 });

  // Learning is best-effort by contract: any failure past validation returns
  // 200 with learned: 0 — a lost learning event must never surface as an error.
  try {
    const { object: terms } = await generateObject({
      model: getModel('extraction'),
      output: 'array',
      schema: z.string().min(2).max(40),
      prompt: buildExtractionPrompt(transcript, final),
    });
    const capped = termsSchema.parse(terms.slice(0, 10));
    if (capped.length === 0) return Response.json({ learned: 0 });

    const { db, companyId } = auth;
    // The unique index is on lower(term), which PostgREST upsert can't
    // target — match case-insensitively in code (the table is tiny).
    const { data: existing } = await db
      .from('transcription_vocab')
      .select('id, term, weight')
      .eq('company_id', companyId);
    const byLower = new Map((existing ?? []).map(row => [row.term.toLowerCase(), row]));

    const now = new Date().toISOString();
    let learned = 0;
    for (const term of capped) {
      const row = byLower.get(term.toLowerCase());
      // Reinforce keeps the manager's latest casing; read-modify-write on
      // weight is fine at one-company traffic.
      const { error } = row
        ? await db
            .from('transcription_vocab')
            .update({ term, weight: row.weight + 1, last_reinforced_at: now })
            .eq('id', row.id)
        : await db
            .from('transcription_vocab')
            .insert({ company_id: companyId, term, last_reinforced_at: now });
      if (!error) learned++;
    }
    return Response.json({ learned });
  } catch {
    return Response.json({ learned: 0 });
  }
}
