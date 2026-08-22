import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

// Session refresh + login gate, run by proxy.ts on every matched request.
// This is UX-layer gating only: the security boundary is RLS plus the
// user-scoped client — a request that somehow slipped past the proxy still
// holds no privileges beyond its own JWT.

// Paths reachable without a session. /offline and the PWA plumbing must stay
// public: the service worker caches /offline at install time, and a redirect
// to /login would poison that cache.
// /auth/signout is deliberately NOT public: sign-out only makes sense with an
// existing session, and any signed-out request there just redirects to /login.
// /auth/confirm and /auth/callback are the routes that ESTABLISH a session
// (email confirmation, password recovery, Google OAuth exchange) — they must
// be reachable before one exists.
// /confirmar-email is by definition read by somebody with no session: it is
// where BOTH a fresh signup and a sign-in blocked on an unconfirmed email land
// (issue #99). Gating it would bounce them to /login — the exact dead end the
// screen exists to end.
// /robots.txt and /sitemap.xml are the crawler contract for the public landing
// page. A crawler never holds a session, so gating them redirects it to /login
// and the landing page is never indexed. That failure is SILENT in the only
// way anyone would check it — a logged-in browser gets a 200 from both — so it
// is only visible to an unauthenticated request. They belong here rather than
// in proxy.ts's matcher for the same reason /manifest.webmanifest does: they
// are generated routes (app/robots.ts, app/sitemap.ts), not static files, and
// the matcher's exemptions are for assets Next serves without running code.
const PUBLIC_PATHS = [
  '/login',
  '/offline',
  '/manifest.webmanifest',
  '/sw.js',
  '/robots.txt',
  '/sitemap.xml',
  '/registar',
  '/confirmar-email',
  '/recuperar',
  '/nova-password',
  '/auth/confirm',
  '/auth/callback',
  '/landing',
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(`${p}/`));
}

export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let supabaseResponse = NextResponse.next({ request });

  // With Fluid compute, never hoist this client to module scope — always a
  // new one per request.
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
          // Cache headers that stop CDNs from caching a response that just
          // rotated a session cookie (would leak the session across users).
          Object.entries(headers ?? {}).forEach(([key, value]) =>
            supabaseResponse.headers.set(key, value as string),
          );
        },
      },
    },
  );

  // Do not run code between createServerClient and getClaims() — and never
  // trust getSession() here. getClaims() verifies the JWT signature against
  // the project's published keys on every request.
  const { data } = await supabase.auth.getClaims();
  const user = data?.claims;

  const { pathname } = request.nextUrl;

  // Anonymous '/' shows the marketing landing page instead of the chat —
  // rewrite (URL stays '/'), not redirect, so PWA start_url and any shared
  // '/' link keep working. Authenticated '/' is untouched below.
  if (!user && pathname === '/') {
    return NextResponse.rewrite(new URL('/landing', request.url));
  }

  if (!user && !isPublic(pathname)) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Não autenticado' }, { status: 401 });
    }
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    return NextResponse.redirect(url);
  }

  if (user && (pathname === '/login' || pathname === '/registar')) {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    url.search = '';
    return NextResponse.redirect(url);
  }

  // Must return the supabaseResponse object as-is so refreshed auth cookies
  // reach both the browser and downstream server components.
  return supabaseResponse;
}
