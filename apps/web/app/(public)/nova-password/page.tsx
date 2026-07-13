import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getAuthState } from '@capo/db/session';
import { setNewPassword } from './actions';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Nova palavra-passe — Capo' };

const NOTICES: Record<string, string> = {
  curta: 'A palavra-passe tem de ter pelo menos 8 caracteres.',
  guardar: 'Não foi possível guardar. Pede um novo link de recuperação.',
};

export default async function NovaPasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ erro?: string }>;
}) {
  // A session here comes from the recovery link's /auth/confirm exchange —
  // no session means the link expired, was already used, or was never valid.
  const state = await getAuthState();
  if (state.status === 'unauthenticated') redirect('/recuperar');

  const { erro } = await searchParams;
  const errorText = erro ? NOTICES[erro] : undefined;

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 pb-16">
      <div className="space-y-2 text-center">
        <p className="text-4xl">🔑</p>
        <h1 className="text-2xl font-semibold">Nova palavra-passe</h1>
      </div>

      <form action={setNewPassword} className="space-y-3">
        <label className="block space-y-1">
          <span className="text-sm font-medium">Palavra-passe nova</span>
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
          Guardar
        </button>
      </form>

      {errorText && (
        <p className="rounded-lg bg-red-500/10 px-3 py-2 text-center text-sm text-red-700 dark:text-red-400">
          {errorText}
        </p>
      )}
    </div>
  );
}
