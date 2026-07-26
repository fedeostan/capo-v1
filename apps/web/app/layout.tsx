import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/react";
import { getCatalog } from "@capo/i18n/catalog";
import { publicLocale } from "@/lib/i18n";
import "./globals.css";
import SwRegister from "./sw-register";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Resolved from the cookie/Accept-Language hint, never the DB: the root layout
// wraps public pages too, and a session lookup here would run on every request
// including /landing and /offline.
export async function generateMetadata(): Promise<Metadata> {
  const t = getCatalog(await publicLocale());
  return { title: t.meta.appName, description: t.meta.appDescription };
}

// maximumScale/userScalable stop iOS from auto-zooming on input focus (pinch
// zoom still works — iOS ignores the cap for user gestures); viewportFit lets
// the bottom nav's safe-area padding take effect on notched phones.
export const viewport: Viewport = {
  themeColor: "#ea580c",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

// NOTE: reading the locale here (via cookies()/headers()) opts the whole tree
// into dynamic rendering, including /landing and /offline. Accepted knowingly:
// this is a PWA, not an SEO property, every (app) route is already
// force-dynamic, and the alternative — a hardcoded lang fixed up client-side —
// is worse for screen readers on first paint.
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const locale = await publicLocale();
  return (
    <html
      lang={locale}
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex h-dvh flex-col pt-[env(safe-area-inset-top)]">
        {children}
        <SwRegister />
        <Analytics />
      </body>
    </html>
  );
}
