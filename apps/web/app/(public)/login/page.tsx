import type { Metadata } from 'next';
import Link from 'next/link';
import { signIn, signInWithGoogle } from './actions';

export const metadata: Metadata = { title: 'Entrar — Capo' };

// TODO(Federico): EU-PT microcopy dial — headline, helper text and the notice
// below are placeholders in your voice's direction; tune them.
const NOTICES: Record<string, { tone: 'ok' | 'err'; text: string }> = {
  'erro-credenciais': {
    tone: 'err',
    text: 'Email ou palavra-passe incorretos. Confirma e tenta de novo.',
  },
  'erro-link-invalido': {
    tone: 'err',
    text: 'O link expirou ou já foi usado. Pede um novo.',
  },
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ erro?: string }>;
}) {
  const params = await searchParams;
  const notice = params.erro ? NOTICES[`erro-${params.erro}`] : undefined;
  const googleEnabled = process.env.NEXT_PUBLIC_GOOGLE_AUTH_ENABLED === '1';

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 pb-16">
      <div className="space-y-2 text-center">
        <p className="text-4xl">👷</p>
        <h1 className="text-2xl font-semibold">Capo</h1>
        <p className="text-sm text-zinc-500">O teu capataz virtual</p>
      </div>

      <form action={signIn} className="space-y-3">
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
        <label className="block space-y-1">
          <span className="text-sm font-medium">Palavra-passe</span>
          <input
            type="password"
            name="password"
            required
            autoComplete="current-password"
            className="w-full rounded-lg border border-zinc-500/30 bg-background px-3 py-2.5 text-base outline-none focus:border-orange-600"
          />
        </label>
        <button
          type="submit"
          className="w-full rounded-lg bg-orange-600 py-2.5 font-semibold text-white active:bg-orange-700"
        >
          Entrar
        </button>
      </form>

      {googleEnabled && (
        <form action={signInWithGoogle}>
          <button
            type="submit"
            className="w-full rounded-lg border border-zinc-500/30 py-2.5 text-sm font-semibold hover:bg-zinc-500/10"
          >
            Entrar com Google
          </button>
        </form>
      )}

      <div className="flex justify-between text-sm text-zinc-500">
        <Link href="/recuperar" className="underline">
          Esqueceste-te da password?
        </Link>
        <Link href="/registar" className="underline">
          Criar conta
        </Link>
      </div>

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
