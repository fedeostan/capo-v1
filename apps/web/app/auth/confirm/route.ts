import { NextResponse, type NextRequest } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { createUserClient } from '@capo/db/user-client';
import { PENDING_EMAIL_COOKIE } from '@/lib/pending-email';

// Handles both signup confirmation and password-recovery links — both arrive
// as {token_hash, type} and are verified identically via the token_hash flow.
// `next` decides where the now-authenticated session lands (onboarding for
// signup confirmation, nova-password for recovery).
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type') as EmailOtpType | null;
  const next = searchParams.get('next') ?? '/';

  if (!tokenHash || !type) {
    return NextResponse.redirect(`${origin}/login?erro=link-invalido`);
  }

  const supabase = await createUserClient();
  const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
  if (error) {
    console.error('verifyOtp failed:', error.message);
    return NextResponse.redirect(`${origin}/login?erro=link-invalido`);
  }

  // Confirmed: nothing is pending any more. Cleared on the response object
  // rather than through cookies(), so the deletion rides the redirect we are
  // actually returning.
  const response = NextResponse.redirect(`${origin}${next}`);
  response.cookies.delete(PENDING_EMAIL_COOKIE);
  return response;
}
