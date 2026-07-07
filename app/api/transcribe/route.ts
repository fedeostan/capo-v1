import { generateText } from 'ai';
import { getModel } from '@/src/agent/models';
import { getApiAuth, type AuthContext } from '@/src/auth/session';

export const maxDuration = 60;

// Browsers record ≤60s of compressed audio; anything near this limit is not a
// voice note gone long, it's a wrong payload.
const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

// TODO(Federico): the steering dial. The name lists come from the DB; the
// fixed wording + glossary below is a placeholder baseline — tune the pt-PT
// instruction and the construction vocabulary to how your crews actually talk.
function buildTranscriptionInstruction(workerNames: string[], jobNames: string[], learnedTerms: string[]): string {
  const lines = [
    'Transcreve o áudio seguinte em português europeu (pt-PT), nunca em português do Brasil.',
    'Devolve apenas o texto transcrito, sem comentários, sem pontuação a mais, sem traduções.',
    'Se não houver fala percetível, devolve uma resposta vazia.',
    'Contexto: um encarregado de uma empresa de construção civil a ditar ordens e notas de obra.',
    'Vocabulário provável: obra, tarefa, demolição, betão, cofragem, alvenaria, estaleiro, empreitada.',
  ];
  if (workerNames.length) lines.push(`Nomes prováveis de trabalhadores: ${workerNames.join(', ')}.`);
  if (jobNames.length) lines.push(`Nomes prováveis de obras: ${jobNames.join(', ')}.`);
  if (learnedTerms.length) lines.push(`Termos e nomes que este encarregado costuma usar: ${learnedTerms.join(', ')}.`);
  return lines.join('\n');
}

async function fetchVocabulary({
  db,
  companyId,
}: AuthContext): Promise<{ workerNames: string[]; jobNames: string[]; learnedTerms: string[] }> {
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

export async function POST(req: Request) {
  const auth = await getApiAuth();
  if (!auth) return Response.json({ error: 'Não autenticado' }, { status: 401 });

  const form = await req.formData();
  const audio = form.get('audio');
  if (!(audio instanceof File) || audio.size === 0) {
    return Response.json({ error: 'Missing audio' }, { status: 400 });
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return Response.json({ error: 'Audio too large' }, { status: 413 });
  }

  try {
    // Vocabulary is best-effort: a transcription without name hints beats a 500.
    const { workerNames, jobNames, learnedTerms } = await fetchVocabulary(auth).catch(() => ({
      workerNames: [] as string[],
      jobNames: [] as string[],
      learnedTerms: [] as string[],
    }));

    const { text } = await generateText({
      model: getModel('transcription'),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: buildTranscriptionInstruction(workerNames, jobNames, learnedTerms) },
            {
              type: 'file',
              // iOS Safari sends audio/mp4, Chrome audio/webm — pass through whatever
              // the browser recorded; Gemini decodes the container itself.
              mediaType: audio.type || 'audio/webm',
              data: new Uint8Array(await audio.arrayBuffer()),
            },
          ],
        },
      ],
    });

    return Response.json({ text: text.trim() });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Transcription failed';
    return Response.json({ error: message }, { status: 500 });
  }
}
