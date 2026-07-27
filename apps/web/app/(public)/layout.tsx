import { publicLocale } from '@/lib/i18n';
import LanguageSwitch from './language-switch';

// Shell for the pre-app surface (login → onboarding → install): same flex
// column as the app shell, but no tab bar — these screens exist before the
// manager "is inside" Capo.
//
// The language switch lives here rather than per-page because every screen in
// this group can be someone's first: Accept-Language may have guessed wrong,
// and there is no profile to correct it from yet.
export default async function PublicLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const locale = await publicLocale();
  return (
    // The scroller lives here rather than in each page: every screen in this
    // group is the same centred column, and the shell above is now
    // unscrollable, so a tall one (a keyboard-open signup form, /landing on a
    // small phone) would otherwise have nowhere to go.
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
      {/* min-h-full, not flex-1: `justify-center` on a column taller than its
          scroll port would push its own top edge out of reach. */}
      <div className="flex min-h-full flex-col">
        {children}
        <LanguageSwitch current={locale} />
      </div>
    </div>
  );
}
