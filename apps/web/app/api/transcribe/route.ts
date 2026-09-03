import { MAX_AUDIO_BYTES, transcribeAudio } from '@capo/core/transcription';
import { getApiAuth } from '@capo/db/session';

export const maxDuration = 60;

// Thin adapter over @capo/core/transcription. The logic lives in the package so
// the WhatsApp webhook — which cannot reach a session-gated route — runs the
// exact same instruction, glossary, and vocabulary as the mic button.
export async function POST(req: Request) {
  const auth = await getApiAuth();
  // No session means no profile means no locale — a 401 body cannot be
  // localized from the user, and no client renders it. English.
  if (!auth) return Response.json({ error: 'Not authenticated' }, { status: 401 });

  const form = await req.formData();
  const audio = form.get('audio');
  if (!(audio instanceof File) || audio.size === 0) {
    return Response.json({ error: 'Missing audio' }, { status: 400 });
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return Response.json({ error: 'Audio too large' }, { status: 413 });
  }

  try {
    const text = await transcribeAudio({
      db: auth.db,
      companyId: auth.companyId,
      // Whose token spend this is (issue #53) — the manager holding the mic.
      profileId: auth.userId,
      locale: auth.locale,
      audio: new Uint8Array(await audio.arrayBuffer()),
      // iOS Safari sends audio/mp4, Chrome audio/webm — pass through whatever
      // the browser recorded; Gemini decodes the container itself.
      mediaType: audio.type || 'audio/webm',
      // The manager's own company's crew and obra names. Their own data, and
      // the single biggest lever on accuracy - see VocabularyScope.
      vocabulary: 'company',
    });
    return Response.json({ text });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Transcription failed';
    return Response.json({ error: message }, { status: 500 });
  }
}
