import { type NextRequest } from 'next/server';
import { updateSession } from '@capo/db/proxy-session';

// Next 16 proxy (the middleware successor): refresh the Supabase session and
// gate unauthenticated traffic before anything renders.
export async function proxy(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    // Everything except Next internals and static assets. sw.js and the
    // manifest DO match — proxy-session.ts allowlists them explicitly.
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
};
