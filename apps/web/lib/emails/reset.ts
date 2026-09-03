import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import { renderEmail, type RenderedEmail } from './shell';

/**
 * "Reset your password" — sent from /recuperar.
 *
 * Same shell as the confirmation email, different words and a different link
 * type (recovery, landing on /nova-password). Ported from
 * docs/emails/password-reset.html and .txt (issue #113).
 */
export function renderResetEmail({
  locale,
  link,
}: {
  locale: Locale;
  link: string;
}): RenderedEmail {
  const t = getCatalog(locale).auth.emails;
  return renderEmail(
    locale,
    {
      subject: t.reset.subject,
      preview: t.reset.preview,
      heading: t.reset.heading,
      body: t.reset.body,
      button: t.reset.button,
      fallback: t.reset.fallback,
      footer: t.reset.footer,
    },
    link,
    (other) => getCatalog(other).auth.emails.reset.otherLine,
  );
}
