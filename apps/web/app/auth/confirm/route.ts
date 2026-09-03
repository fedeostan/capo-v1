import { NextResponse, type NextRequest } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { createUserClient } from '@capo/db/user-client';
import { PENDING_EMAIL_COOKIE } from '@/lib/pending-email';
import { safeNextPath } from '@/lib/safe-next';

// Where every account email lands: signup confirmation, the resend, and
// password recovery. `next` decides where the now-authenticated session goes
// (onboarding for a confirmation, nova-password for a recovery).
//
// TWO shapes arrive here, and the second one is why this route stopped lying.
//
//   {token_hash, type} — the links Capo builds itself (lib/auth-email.ts),
//      verified with verifyOtp. This is the shape we control, and the one
//      everything should arrive as from now on.
//
//   {code}             — what Supabase's OWN mailer forwards. Its default
//      template routes the click through /auth/v1/verify, which consumes the
//      token, confirms the account, and only then redirects here, with a code
//      and no token_hash. This route used to demand a token_hash, find none,
//      and answer "O link expirou ou ja foi usado" to somebody whose account
//      had just been confirmed perfectly well: the account worked, the password
//      worked, and the app said the link was dead.
//
// Accepting the code is not legacy tidiness. It is load-bearing for as long as
// RESEND_API_KEY is unset on the deployment, because sendAuthEmail's documented
// fallback in that state is Supabase's built-in mailer, whose links are exactly
// this shape. Do not delete it before that fallback goes.
//
// `next` names where BOTH shapes land once verification succeeds, and it is
// caller-controlled: it rides the query string, which means a reused or
// rewritten link can carry anything. `${origin}${next}` used to be plain
// string concatenation, which a value like `@evil.com/` turns into a redirect
// to a different host entirely (see lib/safe-next.ts for the mechanism). Two
// layers now stand between that value and the redirect: `safeNextPath` refuses
// anything that is not a plain same-app path, and the `new URL(...).origin`
// check below refuses anything that still resolves off this host.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type') as EmailOtpType | null;
  const code = searchParams.get('code');
  const candidateNext = safeNextPath(searchParams.get('next'), '/');
  let next = '/';
  try {
    next = new URL(candidateNext, origin).origin === origin ? candidateNext : '/';
  } catch {
    next = '/';
  }

  const supabase = await createUserClient();

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (error) {
      console.error('verifyOtp failed:', error.message);
      return NextResponse.redirect(`${origin}/login?erro=link-invalido`);
    }
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      console.error('exchangeCodeForSession failed:', error.message);
      return NextResponse.redirect(`${origin}/login?erro=link-invalido`);
    }
  } else {
    // Nothing to verify at all. The person may still be perfectly fine: a
    // Supabase-shaped link whose token was already spent lands here, which is
    // why the erro=link-invalido copy now tells them to try their password
    // before asking for another link.
    return NextResponse.redirect(`${origin}/login?erro=link-invalido`);
  }

  // Confirmed: nothing is pending any more. Cleared on the response object
  // rather than through cookies(), so the deletion rides the redirect we are
  // actually returning.
  const response = NextResponse.redirect(`${origin}${next}`);
  response.cookies.delete(PENDING_EMAIL_COOKIE);
  return response;
}
