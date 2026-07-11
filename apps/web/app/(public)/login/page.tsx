import type { Metadata } from 'next';
import { sendMagicLink } from './actions';

export const metadata: Metadata = { title: 'Entrar — Capo' };

// TODO(Federico): EU-PT microcopy dial — headline, helper text and the three
// notices below are placeholders in your voice's direction; tune them.
const NOTICES: Record<string, { tone: 'ok' | 'err'; text: string }> = {
  enviado: {
    tone: 'ok',
    text: 'Se o email estiver registado, enviámos-te um link de acesso. Vê a tua caixa de entrada (e o spam).',
  },
  'erro-link': {
    tone: 'err',
    text: 'Esse link expirou ou já foi usado. Pede um novo.',
  },
  'erro-email': {
    tone: 'err',
    text: 'Esse email não parece válido. Confirma e tenta de novo.',
  },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ enviado?: string; erro?: string }>;
}) {
  const params = await searchParams;
  const notice = params.enviado ? NOTICES.enviado : params.erro ? NOTICES[`erro-${params.erro}`] : undefined;

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 pb-16">
      <div className="space-y-2 text-center">
        <p className="text-4xl">👷</p>
        <h1 className="text-2xl font-semibold">Capo</h1>
        <p className="text-sm text-zinc-500">O teu capataz virtual</p>
      </div>

      <form action={sendMagicLink} className="space-y-3">
        <label className="block space-y-1">
          <span className="text-sm font-medium">Email</span>
          <input
            type="email"
            name="email"
            required
            autoComplete="email"
            inputMode="email"
            placeholder="o.teu.email@empresa.pt"
            className="w-full rounded-lg border border-zinc-500/30 bg-background px-3 py-2.5 text-base outline-none focus:border-orange-600"
          />
        </label>
        <button
          type="submit"
          className="w-full rounded-lg bg-orange-600 py-2.5 font-semibold text-white active:bg-orange-700"
        >
          Enviar link de acesso
        </button>
        <p className="text-center text-xs text-zinc-500">
          Sem palavras-passe: recebes um link por email e tocas nele para entrar.
        </p>
      </form>

      {notice && (
        <p
          className={`rounded-lg px-3 py-2 text-center text-sm ${
            notice.tone === 'ok'
              ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
              : 'bg-red-500/10 text-red-700 dark:text-red-400'
          }`}
        >
          {notice.text}
        </p>
      )}
    </div>
  );
}
