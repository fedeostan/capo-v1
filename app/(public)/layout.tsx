// Shell for the pre-app surface (login → onboarding → install): same flex
// column as the app shell, but no tab bar — these screens exist before the
// manager "is inside" Capo.
export default function PublicLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <div className="flex min-h-0 flex-1 flex-col">{children}</div>;
}
