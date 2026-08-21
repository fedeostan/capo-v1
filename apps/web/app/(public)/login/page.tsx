import type { Metadata } from 'next';
import Link from 'next/link';
import { metadataTitle, publicCatalog } from '@/lib/i18n';
import PasswordField from '../password-field';
import { signIn, signInWithGoogle } from './actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: await metadataTitle(t => t.auth.login.submit) };
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ erro?: string }>;
}) {
  const params = await searchParams;
  const { locale, t } = await publicCatalog();
  const errors = t.auth.login.errors;
  // The query keys stay Portuguese — they are part of the redirect contract in
  // ./actions and are never shown to anyone.
  const noticeText = params.erro ? errors[params.erro as keyof typeof errors] : undefined;
  const googleEnabled = process.env.NEXT_PUBLIC_GOOGLE_AUTH_ENABLED === '1';

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 pb-16">
      <div className="space-y-2 text-center">
        <p className="text-4xl">👷</p>
        <h1 className="text-2xl font-semibold">{t.auth.login.title}</h1>
        <p className="text-sm text-zinc-500">{t.meta.appDescription}</p>
      </div>

      <form action={signIn} className="space-y-3">
        <label className="block space-y-1">
          <span className="text-sm font-medium">{t.auth.login.email}</span>
          <input
            type="email"
            name="email"
            required
            autoComplete="email"
            inputMode="email"
            placeholder={t.auth.login.emailPlaceholder}
            className="w-full rounded-lg border border-zinc-500/30 bg-background px-3 py-2.5 text-base outline-none focus:border-orange-600"
          />
        </label>
        <PasswordField
          locale={locale}
          label={t.auth.login.password}
          autoComplete="current-password"
        />
        <button
          type="submit"
          className="w-full rounded-lg bg-orange-600 py-2.5 font-semibold text-white active:bg-orange-700"
        >
          {t.auth.login.submit}
        </button>
      </form>

      {googleEnabled && (
        <form action={signInWithGoogle}>
          <button
            type="submit"
            className="w-full rounded-lg border border-zinc-500/30 py-2.5 text-sm font-semibold hover:bg-zinc-500/10"
          >
            {t.auth.login.google}
          </button>
        </form>
      )}

      <div className="flex justify-between text-sm text-zinc-500">
        <Link href="/recuperar" className="underline">
          {t.auth.login.forgot}
        </Link>
        <Link href="/registar" className="underline">
          {t.auth.login.createAccount}
        </Link>
      </div>

      {noticeText && (
        <p className="rounded-lg bg-red-500/10 px-3 py-2 text-center text-sm text-red-700 dark:text-red-400">
          {noticeText}
        </p>
      )}
    </div>
  );
}
