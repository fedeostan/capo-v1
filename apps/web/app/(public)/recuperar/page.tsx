import type { Metadata } from 'next';
import Link from 'next/link';
import { Button } from '@capo/ui/button';
import { Field, Input } from '@capo/ui/field';
import { metadataTitle, publicCatalog } from '@/lib/i18n';
import { requestPasswordReset } from './actions';

export async function generateMetadata(): Promise<Metadata> {
  return { title: await metadataTitle(t => t.auth.recover.title) };
}

export default async function RecuperarPage({
  searchParams,
}: {
  searchParams: Promise<{ erro?: string; enviado?: string }>;
}) {
  const params = await searchParams;
  const { t } = await publicCatalog();

  if (params.enviado) {
    return (
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 pb-16 text-center">
        <p className="text-4xl">📬</p>
        <h1 className="text-title font-semibold">{t.auth.recover.sentTitle}</h1>
        <p className="text-callout text-fg-muted">{t.auth.recover.sentText}</p>
        <Link href="/login" className="text-callout text-brand underline">
          {t.common.backToLogin}
        </Link>
      </div>
    );
  }

  const errors = t.auth.recover.errors;
  const errorText = params.erro ? errors[params.erro as keyof typeof errors] : undefined;

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 pb-16">
      <div className="space-y-2 text-center">
        <p className="text-4xl">🔑</p>
        <h1 className="text-title font-semibold">{t.auth.recover.title}</h1>
        <p className="text-callout text-fg-muted">{t.auth.recover.subtitle}</p>
      </div>

      <form action={requestPasswordReset} className="space-y-3">
        <Field id="recuperar-email" label={t.auth.login.email}>
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
        <Button type="submit" fullWidth>
          {t.auth.recover.submit}
        </Button>
      </form>

      {errorText && (
        <p className="rounded-lg bg-danger-quiet px-3 py-2 text-center text-callout text-danger">
          {errorText}
        </p>
      )}

      <p className="text-center text-callout text-fg-muted">
        <Link href="/login" className="text-brand underline">
          {t.common.backToLogin}
        </Link>
      </p>
    </div>
  );
}
