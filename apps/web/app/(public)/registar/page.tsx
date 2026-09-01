import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@capo/ui/button';
import { Field, Input } from '@capo/ui/field';
import { metadataTitle, publicCatalog } from '@/lib/i18n';
import PasswordField from '../password-field';
import { signUp } from './actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: await metadataTitle(t => t.auth.signup.title) };
}

// The "we sent you an email" screen used to live here behind ?sucesso=1. It
// moved to /confirmar-email (issue #99) because a failed SIGN-IN now lands on
// it too, and a sign-in dead end pointing at a URL called /registar would read
// as "we lost your account".
export default async function RegistarPage({
  searchParams,
}: {
  searchParams: Promise<{ erro?: string }>;
}) {
  const params = await searchParams;
  const { locale, t } = await publicCatalog();

  const errors = t.auth.signup.errors;
  const errorText = params.erro ? errors[params.erro as keyof typeof errors] : undefined;

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 pb-16">
      <div className="space-y-2 text-center">
        <p className="text-4xl">👷</p>
        <h1 className="text-title font-semibold">{t.auth.signup.title}</h1>
        <p className="text-callout text-fg-muted">{t.auth.signup.subtitle}</p>
      </div>

      <form action={signUp} className="space-y-3">
        <Field id="registar-email" label={t.auth.login.email}>
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
          autoComplete="new-password"
          minLength={8}
        />
        <Button type="submit" fullWidth>
          {t.auth.signup.submit}
        </Button>
        {/* Said BEFORE the press, not after it. The screen that follows was
            always there; two managers still assumed the account was live and
            walked off to sign in. */}
        <p className="text-callout text-fg-muted">{t.auth.signup.emailNote}</p>
      </form>

      {errorText && (
        <p className="rounded-lg bg-danger-quiet px-3 py-2 text-center text-callout text-danger">
          {errorText}
        </p>
      )}

      <p className="text-center text-callout text-fg-muted">
        {t.auth.signup.haveAccount}{' '}
        <Link href="/login" className="text-brand underline">
          {t.auth.signup.signIn}
        </Link>
      </p>
    </div>
  );
}
