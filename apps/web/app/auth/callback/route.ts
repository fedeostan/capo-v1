import { NextResponse, type NextRequest } from 'next/server';
import { createUserClient } from '@capo/db/user-client';

// Google OAuth redirect target — env-gated at the button (NEXT_PUBLIC_GOOGLE_AUTH_ENABLED),
// but this route itself is harmless if hit without that flag: a missing/invalid
// code just bounces back to /login.
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get('code');
  if (!code) return NextResponse.redirect(`${origin}/login?erro=credenciais`);

  const supabase = await createUserClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    console.error('exchangeCodeForSession failed:', error.message);
    return NextResponse.redirect(`${origin}/login?erro=credenciais`);
  }

  return NextResponse.redirect(`${origin}/`);
}
