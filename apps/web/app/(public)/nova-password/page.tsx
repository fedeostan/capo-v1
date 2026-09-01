import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getAuthState } from '@capo/db/session';
import { Button } from '@capo/ui/button';
import { metadataTitle, publicCatalog } from '@/lib/i18n';
import PasswordField from '../password-field';
import { setNewPassword } from './actions';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: await metadataTitle(t => t.auth.newPassword.title) };
}

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
  const { locale, t } = await publicCatalog();
  const errors = t.auth.newPassword.errors;
  const errorText = erro ? errors[erro as keyof typeof errors] : undefined;

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 pb-16">
      <div className="space-y-2 text-center">
        <p className="text-4xl">🔑</p>
        <h1 className="text-title font-semibold">{t.auth.newPassword.title}</h1>
      </div>

      <form action={setNewPassword} className="space-y-3">
        <PasswordField
          locale={locale}
          label={t.auth.newPassword.label}
          autoComplete="new-password"
          minLength={8}
        />
        <Button type="submit" fullWidth>
          {t.common.save}
        </Button>
      </form>

      {errorText && (
        <p className="rounded-lg bg-danger-quiet px-3 py-2 text-center text-callout text-danger">
          {errorText}
        </p>
      )}
    </div>
  );
}
