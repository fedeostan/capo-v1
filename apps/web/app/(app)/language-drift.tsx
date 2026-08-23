import Link from 'next/link';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';

// The two-dial drift notice (issue #55).
//
// WHAT IT IS FOR. Capo carries two language dials that are deliberately
// separate: profiles.language is what it SPEAKS to this manager, and
// companies.language is what it WRITES into task titles and job names. They are
// allowed to differ — that is the whole point of the split, for a foreman who
// does not share his crew's language. What was missing was any signal at all
// that they HAD differed: the manager read English in chat, watched Portuguese
// task titles appear on the board, and had to reverse-engineer the cause from
// the output. Nothing in the product said the two words for "language" were two
// different settings.
//
// So this is an INFORMATION notice, not an error. Three consequences for how it
// is written and where it goes:
//
//   - It never claims something is broken, and it names the case in which the
//     split is correct. A manager who set it on purpose must not be nagged into
//     "fixing" a working setup.
//   - It only ever points at the ONE control that moves both dials together and
//     offers to translate the rows that already exist (/perfil's Language card).
//     It does not duplicate that control, and it never moves a dial itself.
//   - It renders nothing at all when the dials agree, which is the normal state
//     for every tenant. Cheap enough to sit on a screen the manager opens all
//     day, because in the common case it is literally no markup.
//
// The two language names are the endonyms the picker on /perfil already shows
// ("Português", "English", "Español"), so the sentence names the languages with
// the same words as the control it sends him to.
//
// Deliberately a SERVER component with no state: both call sites already hold
// the two locales on the request (ctx.locale / ctx.companyLocale), so this needs
// no query, no client JS, and cannot disagree with the value the agent is using.

function names(locale: Locale, companyLocale: Locale) {
  return {
    you: getCatalog(locale).meta.languageName,
    board: getCatalog(companyLocale).meta.languageName,
  };
}

/**
 * The board version: one quiet row above the task list, linking to the fix.
 *
 * Styled below the amber "materials to buy" banner it sits near, on purpose —
 * this is a standing fact about a setting, not something that has to be acted on
 * today, and an alarm colour on every visit would train the manager to ignore
 * the whole top of the screen.
 */
export function LanguageDriftStrip({ locale, companyLocale }: { locale: Locale; companyLocale: Locale }) {
  if (locale === companyLocale) return null;
  const t = getCatalog(locale);
  return (
    <div className="rounded-card border border-hairline bg-surface p-3">
      <p className="text-caption text-fg-muted">{t.settings.driftBanner(names(locale, companyLocale))}</p>
      <Link href="/perfil" className="mt-1 inline-block text-caption font-medium text-brand underline">
        {t.settings.driftAction}
      </Link>
    </div>
  );
}

/**
 * The /perfil version: the same sentence plus the explanation, sitting at the
 * top of the Language card. No link — the control that fixes it is the next
 * thing on the screen, and a link to the page you are already on is noise.
 */
export function LanguageDriftNote({ locale, companyLocale }: { locale: Locale; companyLocale: Locale }) {
  if (locale === companyLocale) return null;
  const t = getCatalog(locale);
  return (
    <div className="space-y-1 rounded-chip bg-warn-quiet px-3 py-2 text-caption text-warn">
      <p className="font-medium">{t.settings.driftBanner(names(locale, companyLocale))}</p>
      <p>{t.settings.driftHint}</p>
    </div>
  );
}
