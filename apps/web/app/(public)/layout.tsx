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
    <div className="flex min-h-0 flex-1 flex-col">
      {children}
      <LanguageSwitch current={locale} />
    </div>
  );
}
