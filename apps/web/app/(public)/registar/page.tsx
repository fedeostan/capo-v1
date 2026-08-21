import type { Metadata } from 'next';
import Link from 'next/link';
import { metadataTitle, publicCatalog } from '@/lib/i18n';
import PasswordField from '../password-field';
import { signUp } from './actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: await metadataTitle(t => t.auth.signup.title) };
}

export default async function RegistarPage({
  searchParams,
}: {
  searchParams: Promise<{ erro?: string; sucesso?: string }>;
}) {
  const params = await searchParams;
  const { locale, t } = await publicCatalog();

  if (params.sucesso) {
    return (
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 pb-16 text-center">
        <p className="text-4xl">📬</p>
        <h1 className="text-2xl font-semibold">{t.auth.signup.checkEmailTitle}</h1>
        <p className="text-sm text-zinc-500">{t.auth.signup.checkEmailText}</p>
        <Link href="/login" className="text-sm text-orange-600 underline">
          {t.auth.signup.alreadyConfirmed}
        </Link>
      </div>
    );
  }

  const errors = t.auth.signup.errors;
  const errorText = params.erro ? errors[params.erro as keyof typeof errors] : undefined;

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 pb-16">
      <div className="space-y-2 text-center">
        <p className="text-4xl">👷</p>
        <h1 className="text-2xl font-semibold">{t.auth.signup.title}</h1>
        <p className="text-sm text-zinc-500">{t.auth.signup.subtitle}</p>
      </div>

      <form action={signUp} className="space-y-3">
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
          autoComplete="new-password"
          minLength={8}
        />
        <button
          type="submit"
          className="w-full rounded-lg bg-orange-600 py-2.5 font-semibold text-white active:bg-orange-700"
        >
          {t.auth.signup.submit}
        </button>
      </form>

      {errorText && (
        <p className="rounded-lg bg-red-500/10 px-3 py-2 text-center text-sm text-red-700 dark:text-red-400">
          {errorText}
        </p>
      )}

      <p className="text-center text-sm text-zinc-500">
        {t.auth.signup.haveAccount}{' '}
        <Link href="/login" className="text-orange-600 underline">
          {t.auth.signup.signIn}
        </Link>
      </p>
    </div>
  );
}
