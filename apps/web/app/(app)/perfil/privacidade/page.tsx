import type { Metadata } from 'next';
import Link from 'next/link';
import { hasWhatsAppConsent } from '@capo/core/channels/whatsapp';
import { metadataTitle, requireAuthT } from '@/lib/i18n';
import { vapidPublicKey } from '@/lib/push';
import PushCard from '../push-card';
import { RoomShell } from '../room-shell';
import { Card, Flash, WhatsAppConsentPills } from '../settings-controls';

export const dynamic = 'force-dynamic';

export async function generateMetadata(): Promise<Metadata> {
  return { title: await metadataTitle(t => t.shell.rooms.privacy.title) };
}

// What Capo KNOWS and who it may talk to. The three cards here were spread
// across the old single settings page; they belong together because each one
// answers a version of the same question a manager asks about a tool that
// listens: what does it remember, who does it tell, and can it write to my
// crew.
//
// Automatic messages deliberately live in Settings instead (Federico,
// 2026-08-24): a daily 07:00 summary is about how Capo is USED, not about what
// it discloses.
export default async function PrivacidadePage({
  searchParams,
}: {
  searchParams: Promise<{ guardado?: string; erro?: string }>;
}) {
  const { ctx, locale, t } = await requireAuthT();
  const { db, userId } = ctx;
  const { guardado, erro } = await searchParams;
  const pushKey = vapidPublicKey();

  // select('*') for the deploy-ordering reason in AGENTS.md: 0025 adds the two
  // consent columns, and a bundle served before its migration should degrade
  // to "no consent on record" rather than fail the whole page.
  const { data: profile } = await db.from('profiles').select('*').eq('id', userId).maybeSingle();
  const whatsappConsenting = profile ? hasWhatsAppConsent(profile) : false;

  return (
    <RoomShell title={t.shell.rooms.privacy.title} backLabel={t.profile.title} locale={locale}>
      <Flash guardado={guardado} erro={erro} t={t} />

      {/* Nothing proactive is sent without this — see hasWhatsAppConsent and
          0025_whatsapp_optin.sql. */}
      <Card title={t.settings.whatsappConsent}>
        <p className="text-xs text-zinc-500">{t.settings.whatsappConsentHint}</p>
        {/* Said on the control that causes it (issue #45): turning consent on
            is what lets Capo introduce itself, and that introduction is a paid
            WhatsApp template. Shown only while consent is OFF — once it is on,
            the welcome has been sent and the sentence is history. */}
        {!whatsappConsenting && <p className="text-xs text-zinc-500">{t.settings.whatsappConsentCost}</p>}
        <p
          className={`text-xs ${whatsappConsenting ? 'text-emerald-700 dark:text-emerald-400' : 'text-amber-700 dark:text-amber-400'}`}
        >
          {whatsappConsenting ? t.settings.whatsappConsentOn : t.settings.whatsappConsentOff}
        </p>
        <WhatsAppConsentPills consenting={whatsappConsenting} t={t} />
      </Card>

      {/* Not wrapped in <Card>: this component owns its own container so it
          can render nothing at all when push is unconfigured or unsupported,
          rather than leaving an empty bordered box on the screen. */}
      {pushKey && <PushCard locale={locale} vapidPublicKey={pushKey} />}

      {/* The inbox is what Capo told YOU. */}
      <Card title={t.notifications.title}>
        <Link href="/notificacoes" className="inline-block text-sm text-orange-600 underline">
          {t.notifications.profileLink}
        </Link>
      </Card>

      {/* And this is what it decided to REMEMBER — including what it wrote
          down by itself at 03:00 (issue #48). It is not a setting: it is a
          list of facts about the manager and his company that he can delete. */}
      <Card title={t.memory.title}>
        <p className="text-xs text-zinc-500">{t.memory.subtitle}</p>
        <Link href="/perfil/memoria" className="inline-block text-sm text-orange-600 underline">
          {t.memory.profileLink}
        </Link>
      </Card>
    </RoomShell>
  );
}
