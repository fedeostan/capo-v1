import { NextResponse, type NextRequest } from 'next/server';
import { createUserClient } from '@capo/db/user-client';

// POST-only sign-out (GET would make it triggerable by a prefetched link).
export async function POST(request: NextRequest) {
  const supabase = await createUserClient();
  const { data } = await supabase.auth.getClaims();
  if (data?.claims) {
    await supabase.auth.signOut();
  }
  const url = request.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url, { status: 303 });
}
