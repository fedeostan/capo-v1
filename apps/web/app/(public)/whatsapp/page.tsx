import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireAuth } from '@capo/db/session';
import { getCatalog } from '@capo/i18n/catalog';
import { metadataTitle } from '@/lib/i18n';
import { logEvent } from '@/lib/log';
import { qrGeometry } from '@/lib/qr';
import { buildWhatsAppLink } from '@/lib/whatsapp-handshake';
import Handshake from './handshake';

// force-dynamic: this page reads a server-only env var and the caller's own
// profile row. A statically rendered version would bake in one manager's phone
// number and be built without the env var present.
export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: await metadataTitle(t => t.whatsappHandshake.title) };
}

/**
 * The step between the details form and the install guide: hand the manager
 * into the WhatsApp channel, and confirm out loud when they arrive. Issue #84.
 *
 * requireAuth() is both the gate and the precondition. Unauthenticated →
 * /login, no profile row → /onboarding, and that second one is not merely
 * tidiness: Capo recognises an inbound WhatsApp message by matching the sender
 * against profiles.phone, so without that row this screen would invite someone
 * to message a Capo that structurally cannot answer them.
 *
 * (The proxy already refuses a session-less request — /whatsapp is absent from
 * PUBLIC_PATHS in packages/db/src/proxy-session.ts — so this is the second
 * lock, not the only one.)
 */
export default async function WhatsAppPage() {
  const { db, userId, companyId, locale } = await requireAuth();
  const t = getCatalog(locale);

  // Inside the request, never at module scope: a module-scope read of a
  // server-only variable breaks `next build`, where secrets are absent.
  const link = buildWhatsAppLink(process.env.WHATSAPP_BUSINESS_NUMBER ?? '', t.whatsappHandshake.prefill);
  if (!link) {
    // Skip the screen rather than render a button that goes nowhere: a dead
    // button on the last step of signup is worse than no step at all. Logged
    // because a silent skip would make a misconfigured deployment look like a
    // design decision.
    logEvent('handshake.no_business_number', { companyId });
    redirect('/instalar');
  }

  // The phone is shown ONLY in the 90-second "is this really your number?"
  // line. Its own query rather than widening getAuthState's: that one runs on
  // every authenticated page in the product and must not grow columns for one
  // screen's copy.
  const { data: profile, error: phoneError } = await db
    .from('profiles')
    .select('phone')
    .eq('id', userId)
    .maybeSingle();
  if (phoneError) {
    // The screen still renders on a failed read — a missing phone number must
    // not take down the whole handshake. But `profile?.phone ?? ''` below then
    // renders the stalled sentence with its answer missing (t.stalled('') —
    // "O  é o número do teu WhatsApp?"), which is a degraded state, not a
    // normal empty one, and every other read on this branch logs its failure.
    logEvent('handshake.phone_read_failed', { companyId, userId, error: phoneError.message });
  }

  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 pb-16">
      <div className="space-y-2 text-center">
        <p className="text-4xl">💬</p>
        <h1 className="text-2xl font-semibold">{t.whatsappHandshake.title}</h1>
        <p className="text-sm text-zinc-500">{t.whatsappHandshake.subtitle}</p>
      </div>
      <Handshake locale={locale} link={link} qr={qrGeometry(link)} phone={profile?.phone ?? ''} />
    </div>
  );
}
