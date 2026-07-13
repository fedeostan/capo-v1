import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Capo — Operator',
  robots: { index: false, follow: false },
};

const NAV = [
  { href: '/', label: 'Overview' },
  { href: '/conversations', label: 'Conversations' },
  { href: '/tasks', label: 'Tasks' },
  { href: '/dispatch', label: 'Dispatch log' },
  { href: '/signups', label: 'Signups' },
];

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        <header className="border-b border-zinc-500/20 px-4 py-3">
          <div className="mx-auto flex max-w-5xl items-center gap-6">
            <span className="text-sm font-semibold">Capo · mission control</span>
            <nav className="flex gap-4 text-sm text-zinc-500">
              {NAV.map(item => (
                <Link key={item.href} href={item.href} className="hover:text-zinc-300 hover:underline">
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
