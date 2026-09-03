import { LOCALES, type Locale } from '@capo/i18n/locale';
import { getCatalog } from '@capo/i18n/catalog';

// The shared shell for the two account emails Capo sends itself (confirm
// signup, password reset). Both were Go templates pasted into the Supabase
// dashboard until W1; the design is ported from docs/emails/confirm-email.html
// and password-reset.html unchanged, so anything about the LOOK that surprises
// you was a decision taken in issue #113 and is recorded here.
//
// Why a shared module and not two copies: the two emails are the same card
// with different words. Two copies of the markup would eventually disagree,
// and the way a person notices is that one of the two most important emails in
// the product renders badly in their mail client and the other does not.
//
// ── THE ONE THING THAT IS NEW ──────────────────────────────────────────────
// The Supabase templates stacked all three languages in every message, because
// a Go template rendered inside GoTrue cannot know who is reading it
// (profiles.language does not exist yet at signup). The app DOES know: the
// public pages already resolve a locale from the LanguageSwitch cookie, then
// Accept-Language. So the reader's language is rendered FULLY and the other
// two appear as one line each under a divider, which is what `otherLine` in
// the catalog is for. Nobody loses a language; the right one is just first.
//
// ── COLOURS ────────────────────────────────────────────────────────────────
// Hardcoded LIGHT-THEME hex from packages/ui/src/tokens.css, because email
// clients cannot read CSS variables. No dark-mode styles on purpose: dark mode
// in email is unreliable across clients and was left out of issue #113.
//
//   #fafaf9  --bg        page background
//   #ffffff  --surface   card
//   #1c1917  --fg        primary text
//   #57534e  --fg-muted  secondary text
//   #78716c  --fg-faint  footer text
//   #e7e5e4  --hairline  card border, divider
//   #c2410c  --brand     wordmark, button, links (safe behind white text)
//   #ffffff  --on-brand  button label
//
// Radii: 16px = --radius-card, 12px = --radius-control. Tables plus inline
// styles throughout, one column, max-width 480px, one full-width button with a
// tap target of at least 48px. Managers read these on a phone. No images: they
// are blocked by default in many clients, and a blocked logo as somebody's
// first impression of Capo is worse than no logo.

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

/** The parts a single account email needs, already in the reader's language. */
export interface EmailParts {
  subject: string;
  preview: string;
  heading: string;
  body: string;
  button: string;
  fallback: string;
  footer: string;
}

/**
 * Escape for HTML text AND for an attribute value. Every catalog string and
 * the link itself go through this.
 *
 * The link is the reason this is not optional: it carries `&type=…&next=…`,
 * and a bare `&` inside an href is a parse error waiting to be interpreted
 * differently by every mail client. The Supabase templates wrote `&amp;` by
 * hand for exactly this; here it falls out of escaping instead.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The other two languages, in the catalog's own order, never including the
 * reader's own. Derived from LOCALES rather than listed, so adding a locale
 * adds a line here with no edit.
 */
export function otherLocales(reader: Locale): Locale[] {
  return LOCALES.filter((l) => l !== reader);
}

/** The one short line per other language, already labelled. */
function otherLines(reader: Locale, pick: (locale: Locale) => string): string[] {
  return otherLocales(reader).map((locale) => {
    const t = getCatalog(locale);
    return `${t.auth.emails.languageLabel}: ${pick(locale)}`;
  });
}

export function renderEmail(
  reader: Locale,
  parts: EmailParts,
  link: string,
  pickOther: (locale: Locale) => string,
): RenderedEmail {
  const e = escapeHtml;
  const href = e(link);
  const others = otherLines(reader, pickOther);

  const html = `<!doctype html>
<html lang="${e(reader.slice(0, 2))}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="x-apple-disable-message-reformatting" />
    <title>${e(parts.subject)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:#fafaf9;">
    <div style="display:none;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${e(parts.preview)}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#fafaf9" style="background-color:#fafaf9;">
      <tr>
        <td align="center" style="padding:24px 16px 40px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;">
            <tr>
              <td style="padding:8px 4px 16px;font-family:${FONT};font-size:24px;line-height:28px;font-weight:700;color:#c2410c;">
                Capo
              </td>
            </tr>
            <tr>
              <td bgcolor="#ffffff" style="background-color:#ffffff;border:1px solid #e7e5e4;border-radius:16px;padding:32px 24px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="font-family:${FONT};font-size:22px;line-height:28px;font-weight:700;color:#1c1917;padding-bottom:12px;">
                      ${e(parts.heading)}
                    </td>
                  </tr>
                  <tr>
                    <td style="font-family:${FONT};font-size:16px;line-height:24px;color:#1c1917;padding-bottom:24px;">
                      ${e(parts.body)}
                    </td>
                  </tr>
                  <tr>
                    <td>
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                        <tr>
                          <td align="center" bgcolor="#c2410c" style="background-color:#c2410c;border-radius:12px;">
                            <a href="${href}" target="_blank" style="display:block;padding:15px 24px;font-family:${FONT};font-size:16px;line-height:24px;font-weight:600;color:#ffffff;text-decoration:none;">
                              ${e(parts.button)}
                            </a>
                          </td>
                        </tr>
                      </table>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding-top:16px;font-family:${FONT};font-size:13px;line-height:18px;color:#57534e;">
                      ${e(parts.fallback)}<br />
                      <a href="${href}" target="_blank" style="color:#c2410c;word-break:break-all;">${href}</a>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding:24px 0;">
                      <div style="border-top:1px solid #e7e5e4;font-size:0;line-height:0;">&nbsp;</div>
                    </td>
                  </tr>
${others
  .map(
    (line, index) => `                  <tr>
                    <td style="font-family:${FONT};font-size:14px;line-height:21px;color:#57534e;${index === others.length - 1 ? '' : 'padding-bottom:16px;'}">
                      ${e(line)}
                    </td>
                  </tr>`,
  )
  .join('\n')}
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 4px 0;font-family:${FONT};font-size:13px;line-height:18px;color:#78716c;">
                ${e(parts.footer)}
              </td>
            </tr>
            <tr>
              <td style="padding:12px 4px 0;font-family:${FONT};font-size:13px;line-height:18px;color:#78716c;">
                Capo &middot; <a href="https://www.construcapo.com" target="_blank" style="color:#78716c;">construcapo.com</a>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;

  // The plain-text twin. Resend takes both parts, which the Supabase dashboard
  // never did (it has one HTML body field and no text field) — so the .txt
  // files in docs/emails were a copy reference that nothing could send. They
  // can be sent now, which is why they became this.
  const text = [
    `CAPO`,
    ``,
    parts.heading,
    ``,
    parts.body,
    ``,
    `${parts.button}:`,
    link,
    ``,
    // The catalog string ends with a colon because in the HTML part it
    // introduces the address on the next line. Here the address is already
    // above it, so it closes as a sentence instead. One string, two parts, no
    // second catalog entry to keep in step.
    parts.fallback.replace(/:\s*$/, '.'),
    ``,
    `---`,
    ``,
    ...others,
    ``,
    `---`,
    ``,
    parts.footer,
    ``,
    `Capo · construcapo.com`,
  ].join('\n');

  return { subject: parts.subject, html, text };
}
