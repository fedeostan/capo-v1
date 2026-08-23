import { NextResponse, type NextRequest } from 'next/server';
import { updateSession } from '@capo/db/proxy-session';

// Next 16 proxy (the middleware successor): refresh the Supabase session and
// gate unauthenticated traffic before anything renders.
export async function proxy(request: NextRequest) {
  // The WhatsApp and Stripe webhooks and the Vercel Cron invocations are
  // server→server traffic with no browser session; their structural gates are
  // inside the routes (HMAC signature, Stripe signature, and the CRON_SECRET
  // bearer token respectively). Running the session machinery here would only
  // 401 every legitimate delivery.
  const { pathname } = request.nextUrl;
  if (pathname === '/api/whatsapp' || pathname === '/api/stripe/webhook' || pathname.startsWith('/api/cron/')) {
    return NextResponse.next();
  }
  // The design-system gallery renders nothing but hardcoded fixtures, and its
  // entire purpose is being reviewable without a login. In production the pages
  // themselves call notFound(), so this branch is dead there — the NODE_ENV
  // guard means production's auth posture is unchanged on both layers.
  if (process.env.NODE_ENV !== 'production' && pathname.startsWith('/design-system')) {
    return NextResponse.next();
  }
  return await updateSession(request);
}

export const config = {
  matcher: [
    // Everything except Next internals and static assets. The generated public
    // routes — sw.js, the manifest, robots.txt, sitemap.xml — DO match;
    // proxy-session.ts allowlists them explicitly.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
