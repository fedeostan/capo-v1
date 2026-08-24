import type { Metadata } from 'next';
import { metadataTitle, requireAuthT } from '@/lib/i18n';
import { AccountForm, CompanyForm } from '../profile-forms';
import { RoomShell } from '../room-shell';
import { Card, Flash } from '../settings-controls';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: await metadataTitle(t => t.shell.rooms.personal.title) };
}

export default async function PessoalPage({
  searchParams,
}: {
  searchParams: Promise<{ guardado?: string; erro?: string }>;
}) {
  const { ctx, locale, t } = await requireAuthT();
  const { db, userId, companyId } = ctx;
  const { guardado, erro } = await searchParams;

  const [{ data: company }, { data: profile }, { data: claims }] = await Promise.all([
    db.from('companies').select('name').eq('id', companyId).maybeSingle(),
    // select('*') for the deploy-ordering reason in AGENTS.md: 0025 adds the two
    // consent columns, and a bundle served before its migration should degrade
    // to "no consent on record" rather than fail the whole page.
    db.from('profiles').select('*').eq('id', userId).maybeSingle(),
    db.auth.getClaims(),
  ]);

  const email = typeof claims?.claims?.email === 'string' ? claims.claims.email : null;

  return (
    <RoomShell title={t.shell.rooms.personal.title} backLabel={t.profile.title} locale={locale}>
      <Flash guardado={guardado} erro={erro} t={t} />

      <Card title={t.profile.company}>
        <CompanyForm name={company?.name ?? ''} locale={locale} />
      </Card>

      <Card title={t.profile.yourAccount}>
        {/* Changing the login email is a Supabase auth flow with its own
            confirmation round trip — out of scope here, so it is read-only. */}
        {email && <p className="text-caption text-fg-muted">{email}</p>}
        <AccountForm fullName={profile?.full_name ?? ''} phone={profile?.phone ?? ''} locale={locale} />
      </Card>
    </RoomShell>
  );
}
