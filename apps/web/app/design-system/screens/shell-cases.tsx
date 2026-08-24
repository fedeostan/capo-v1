'use client';

// The Round 1 shell, on the dev-only gallery, with the drawer and the sheet
// held OPEN so a screenshot can catch them.
//
// A client component because both overlays are state-driven and the gallery
// page is a server component. It renders the real TopBar and the real
// DeleteAccountSheet — a hand-drawn copy here would be a second design that
// drifts from the shipped one, which is the whole failure this route exists
// to prevent.
import { useState } from 'react';
import { DEFAULT_LOCALE } from '@capo/i18n/locale';
import { ProfileDrawer } from '@/app/_ui/profile-drawer';
import { DeleteAccountSheet } from '@/app/(app)/perfil/definicoes/delete-account-sheet';

function Case({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-hairline pt-6">
      <h2 className="text-heading font-semibold text-fg">{title}</h2>
      {children}
    </section>
  );
}

export function ShellCases() {
  const [drawer, setDrawer] = useState(false);

  return (
    <>
      <Case title="8. Top bar — a company name long enough to fight the buttons">
        {/* CHECK THIS BY RESIZING THE VIEWPORT, not by reading it at desktop
            width. The name block hides itself below 360px via a media query,
            and a media query asks the VIEWPORT — so a narrow container here
            would show the name at any window size and prove nothing. Narrow
            the window to 320px (the smallest phone this app supports) and the
            name should disappear, leaving the avatar alone and every control
            still at its 44px target. */}
        <div className="overflow-hidden rounded-card border border-hairline">
          <TopBarPreview name="Miguel Ferreira" company="Ferreira &amp; Filhos, Sociedade de Construções Lda" />
        </div>
        <div className="overflow-hidden rounded-card border border-hairline">
          <TopBarPreview name="Miguel Ferreira" company="Ferreira &amp; Filhos" />
        </div>
        {/* A profile with no name yet — complete_onboarding() can create one
            before a name is set. The avatar must not read "null". */}
        <div className="overflow-hidden rounded-card border border-hairline">
          <TopBarPreview name={null} company={null} />
        </div>
      </Case>

      <Case title="9. Profile drawer — five rooms, open">
        <button
          type="button"
          onClick={() => setDrawer(true)}
          className="min-h-11 self-start rounded-control border border-control px-4 text-callout font-semibold text-fg"
        >
          Open the drawer
        </button>
        <ProfileDrawer
          open={drawer}
          onClose={() => setDrawer(false)}
          locale={DEFAULT_LOCALE}
          name="Miguel Ferreira"
          company="Ferreira &amp; Filhos"
          initials="MF"
        />
      </Case>

      <Case title="10. Delete account — the row, and a confirm that stays disabled">
        <DeleteAccountSheet locale={DEFAULT_LOCALE} companyName="Ferreira &amp; Filhos, Lda" />
      </Case>
    </>
  );
}

// TopBar reads usePathname to decide whether it belongs on the current route,
// and the gallery is not one of the tab roots — so the real component would
// correctly render nothing here. This preview borrows its markup to show the
// layout cases. It is the one hand-copy on this page and it is a KNOWN one:
// it can only ever be wrong about spacing, never about behaviour, because
// every behaviour it might have drifted on lives in the drawer beside it.
function TopBarPreview({ name, company }: { name: string | null; company: string | null }) {
  const initials = name
    ? name
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map(p => p[0]!.toUpperCase())
        .join('')
    : '·';
  const iconButton =
    'grid min-h-11 min-w-11 shrink-0 place-items-center rounded-control text-fg-muted';
  return (
    <header className="flex shrink-0 items-center justify-between gap-2 border-b border-hairline bg-surface px-2 py-1">
      <div className="flex min-w-0 items-center">
        <span className={iconButton}>
          <Icon>
            <path d="M4 7h16M4 12h16M4 17h16" />
          </Icon>
        </span>
        <span className="flex min-h-11 min-w-0 items-center gap-2 rounded-control px-1">
          <span className="relative grid h-9 w-9 shrink-0 place-items-center rounded-full bg-brand-quiet text-caption font-semibold text-brand">
            {initials}
            <span className="absolute -right-px -bottom-px h-2 w-2 rounded-full border-2 border-surface bg-success-solid" />
          </span>
          <span className="hidden min-w-0 flex-col items-start leading-tight min-[360px]:flex">
            {name && <span className="truncate text-caption font-semibold text-fg">{name}</span>}
            {company && <span className="truncate text-micro text-fg-faint">{company}</span>}
          </span>
        </span>
      </div>
      <div className="flex shrink-0 items-center">
        <span className={`${iconButton} opacity-40`}>
          <Icon>
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.6-3.6" />
          </Icon>
        </span>
        <span className={iconButton}>
          <Icon>
            <rect x="9" y="2" width="6" height="11" rx="3" />
            <path d="M5 11a7 7 0 0 0 14 0M12 18v4" />
          </Icon>
        </span>
        <span className="ml-1 grid min-h-11 min-w-11 shrink-0 place-items-center rounded-control bg-brand text-on-brand">
          <Icon>
            <path d="M12 5v14M5 12h14" />
          </Icon>
        </span>
      </div>
    </header>
  );
}

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}
