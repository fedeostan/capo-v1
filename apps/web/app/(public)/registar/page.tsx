import type { Metadata } from 'next';
import Link from 'next/link';
import { signUp } from './actions';

export const metadata: Metadata = { title: 'Criar conta — Capo' };

// TODO(Federico): EU-PT microcopy dial — same category as login/onboarding.
const NOTICES: Record<string, string> = {
  dados: 'Preenche um email válido e uma palavra-passe com pelo menos 8 caracteres.',
  fechado: 'Os registos abrem em breve — pede um convite.',
};

export default async function RegistarPage({
  searchParams,
}: {
  searchParams: Promise<{ erro?: string; sucesso?: string }>;
}) {
  const params = await searchParams;

  if (params.sucesso) {
    return (
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 pb-16 text-center">
        <p className="text-4xl">📬</p>
        <h1 className="text-2xl font-semibold">Confirma o teu email</h1>
        <p className="text-sm text-zinc-500">Enviámos um link de confirmação — abre-o para começares.</p>
        <Link href="/login" className="text-sm text-orange-600 underline">
          Já confirmaste? Entra aqui
        </Link>
      </div>
    );
  }

  const errorText = params.erro ? NOTICES[params.erro] : undefined;

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 pb-16">
      <div className="space-y-2 text-center">
        <p className="text-4xl">👷</p>
        <h1 className="text-2xl font-semibold">Criar conta</h1>
        <p className="text-sm text-zinc-500">14 dias grátis. Sem cartão de crédito.</p>
      </div>

      <form action={signUp} className="space-y-3">
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
            minLength={8}
            autoComplete="new-password"
            className="w-full rounded-lg border border-zinc-500/30 bg-background px-3 py-2.5 text-base outline-none focus:border-orange-600"
          />
        </label>
        <button
          type="submit"
          className="w-full rounded-lg bg-orange-600 py-2.5 font-semibold text-white active:bg-orange-700"
        >
          Criar conta
        </button>
      </form>

      {errorText && (
        <p className="rounded-lg bg-red-500/10 px-3 py-2 text-center text-sm text-red-700 dark:text-red-400">
          {errorText}
        </p>
      )}

      <p className="text-center text-sm text-zinc-500">
        Já tens conta?{' '}
        <Link href="/login" className="text-orange-600 underline">
          Entra aqui
        </Link>
      </p>
    </div>
  );
}
