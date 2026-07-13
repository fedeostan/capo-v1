import type { Metadata } from 'next';
import Link from 'next/link';
import { requestPasswordReset } from './actions';

export const metadata: Metadata = { title: 'Recuperar palavra-passe — Capo' };

const NOTICES: Record<string, string> = {
  dados: 'Indica um email válido.',
};

export default async function RecuperarPage({
  searchParams,
}: {
  searchParams: Promise<{ erro?: string; enviado?: string }>;
}) {
  const params = await searchParams;

  if (params.enviado) {
    return (
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 pb-16 text-center">
        <p className="text-4xl">📬</p>
        <h1 className="text-2xl font-semibold">Verifica o teu email</h1>
        <p className="text-sm text-zinc-500">
          Se existir uma conta com esse email, enviámos um link para repores a palavra-passe.
        </p>
        <Link href="/login" className="text-sm text-orange-600 underline">
          Voltar a entrar
        </Link>
      </div>
    );
  }

  const errorText = params.erro ? NOTICES[params.erro] : undefined;

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 pb-16">
      <div className="space-y-2 text-center">
        <p className="text-4xl">🔑</p>
        <h1 className="text-2xl font-semibold">Recuperar palavra-passe</h1>
        <p className="text-sm text-zinc-500">Indica o teu email — enviamos-te um link.</p>
      </div>

      <form action={requestPasswordReset} className="space-y-3">
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
          Enviar link
        </button>
      </form>

      {errorText && (
        <p className="rounded-lg bg-red-500/10 px-3 py-2 text-center text-sm text-red-700 dark:text-red-400">
          {errorText}
        </p>
      )}

      <p className="text-center text-sm text-zinc-500">
        <Link href="/login" className="text-orange-600 underline">
          Voltar a entrar
        </Link>
      </p>
    </div>
  );
}
