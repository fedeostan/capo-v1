'use client';

import { useEffect } from 'react';
import { LOCALE_COOKIE } from '@/lib/i18n-shared';
import type { Locale } from '@capo/i18n/locale';

// Keeps the capo_lang hint cookie in step with profiles.language.
//
// Needed because the chat-driven path (`set_language`) writes the DB from
// inside a streaming response, and a streaming response cannot set cookies.
// Without this, a manager who switches language in chat keeps getting the OLD
// language on /login, on <html lang>, and in tab titles until some server
// action happens to rewrite the cookie.
//
// The cookie is only ever a hint — nothing that renders tenant data trusts it —
// so writing it from the client is safe by construction.
export default function LocaleCookieSync({ locale }: { locale: Locale }) {
  useEffect(() => {
    const current = document.cookie
      .split('; ')
      .find(row => row.startsWith(`${LOCALE_COOKIE}=`))
      ?.slice(LOCALE_COOKIE.length + 1);
    if (current === locale) return;
    document.cookie = `${LOCALE_COOKIE}=${locale}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
  }, [locale]);

  return null;
}
