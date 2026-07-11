import BottomNav from '@/app/bottom-nav';

// The logged-in shell: everything in (app) sits above the tab bar. Auth is
// enforced per page/route via requireAuth()/getApiAuth() — a layout persists
// across client-side navigations, so it cannot be the gate.
export default function AppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      <BottomNav />
    </>
  );
}
