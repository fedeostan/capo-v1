import type { EmailOtpType } from '@supabase/supabase-js';
import { type NextRequest, NextResponse } from 'next/server';
import { createUserClient } from '@/src/db/user-client';

// Magic-link / invite landing. The email templates point here with a
// token_hash (never a raw token in a clickable URL), exchanged server-side
// via verifyOtp — the SSR-recommended flow. On success we just go to `next`:
// requireAuth() downstream routes users without a profile to /onboarding.
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const token_hash = searchParams.get('token_hash');
  const type = searchParams.get('type') as EmailOtpType | null;
  const nextParam = searchParams.get('next') ?? '/';
  // relative paths only — a full URL here would be an open redirect
  const next = nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : '/';

  const redirectTo = request.nextUrl.clone();
  redirectTo.search = '';

  if (token_hash && type) {
    const supabase = await createUserClient();
    const { error } = await supabase.auth.verifyOtp({ type, token_hash });
    if (!error) {
      redirectTo.pathname = next;
      return NextResponse.redirect(redirectTo);
    }
  }

  // expired/used link — back to login with a hint the page can render
  redirectTo.pathname = '/login';
  redirectTo.searchParams.set('erro', 'link');
  return NextResponse.redirect(redirectTo);
}
