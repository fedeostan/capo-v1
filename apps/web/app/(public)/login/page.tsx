import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@capo/ui/button';
import { Field, Input } from '@capo/ui/field';
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
        <h1 className="text-title font-semibold">{t.auth.login.title}</h1>
        <p className="text-callout text-fg-muted">{t.meta.appDescription}</p>
      </div>

      <form action={signIn} className="space-y-3">
        <Field id="login-email" label={t.auth.login.email}>
          {a11y => (
            <Input
              {...a11y}
              type="email"
              name="email"
              required
              autoComplete="email"
              inputMode="email"
              placeholder={t.auth.login.emailPlaceholder}
            />
          )}
        </Field>
        <PasswordField
          locale={locale}
          label={t.auth.login.password}
          autoComplete="current-password"
        />
        <Button type="submit" fullWidth>
          {t.auth.login.submit}
        </Button>
      </form>

      {googleEnabled && (
        <form action={signInWithGoogle}>
          <Button type="submit" variant="secondary" fullWidth>
            {t.auth.login.google}
          </Button>
        </form>
      )}

      <div className="flex justify-between text-callout text-fg-muted">
        <Link href="/recuperar" className="underline">
          {t.auth.login.forgot}
        </Link>
        <Link href="/registar" className="underline">
          {t.auth.login.createAccount}
        </Link>
      </div>

      {noticeText && (
        <p className="rounded-lg bg-danger-quiet px-3 py-2 text-center text-callout text-danger">
          {noticeText}
        </p>
      )}
    </div>
  );
}
