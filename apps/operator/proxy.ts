import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';

// Structural gate for the operator app: EVERY request must carry HTTP Basic
// credentials matching OPERATOR_BASIC_AUTH ("user:password", server-only env,
// read lazily). There is no tenant login surface here at all — this app never
// ships the publishable/RLS client, and without credentials it answers 401
// (or 503 if the secret is unset: fail closed, never open).
//
// A second, platform-level layer (Vercel Deployment Protection) is documented
// in docs/operator-runbook.md.
export function proxy(request: NextRequest) {
  const expected = process.env.OPERATOR_BASIC_AUTH;
  if (!expected) {
    return new NextResponse('operator auth not configured', { status: 503 });
  }

  const header = request.headers.get('authorization') ?? '';
  const provided = header.startsWith('Basic ')
    ? Buffer.from(header.slice(6), 'base64').toString('utf8')
    : '';

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  if (!ok) {
    return new NextResponse('authentication required', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="capo-operator"' },
    });
  }

  return NextResponse.next();
}

export const config = {
  // Everything, including API-ish paths; only Next internals are exempt.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
