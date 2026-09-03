// Where a redirect goes after Capo verifies something (a confirmed signup, a
// password reset, a resent magic link) is named by a `next` query parameter
// that rides the email link itself. That link can be reused, forwarded, or
// have `next` rewritten by whoever hands it to a victim, so `next` is
// attacker-controlled input, not a value the app chose.
//
// `${origin}${next}` used to be plain string concatenation, not URL
// resolution, and that is the whole bug this file closes. A `next` of
// `@evil.com/` concatenated onto `https://www.construcapo.com` produces
// `https://www.construcapo.com@evil.com/`, which every browser resolves as a
// request to `evil.com` with `www.construcapo.com` thrown away as userinfo —
// the classic `trusted-host@attacker-host` trick. The token check above it
// succeeds exactly as designed; the hole is entirely in what happens after,
// which is why it does not matter whose link was reused.
//
// `safeNextPath` is the pure, syntax-level half of the fix: no network, no
// origin, so it is easy to pin with `pnpm email-check`. The caller does a
// second, origin-resolving check on top of it with
// `new URL(candidate, origin).origin === origin` — belt and braces, because a
// syntax check can miss an encoding trick a real URL parser would not.
export function safeNextPath(next: string | null, fallback: string): string {
  if (!next) return fallback;

  // Exactly one leading slash. Never protocol-relative ("//evil.com", which a
  // browser reads as "same scheme, different host") and never its backslash
  // variant ("/\\evil.com" — some browsers normalise a leading backslash into
  // a second forward slash before parsing).
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;

  // The userinfo@host trick this file exists to close.
  if (next.includes('@')) return fallback;

  // A backslash anywhere, not only at the front.
  if (next.includes('\\')) return fallback;

  // A scheme immediately inside the path ("/javascript:alert(1)"). The
  // leading-slash rule above already refuses a bare "javascript:alert(1)" or
  // "https://evil.com" (neither starts with '/'), but a colon before the
  // first '/', '?' or '#' is worth refusing outright rather than trusting
  // every future reader of this value to never treat it as a scheme.
  if (/^\/[^/?#]*:/.test(next)) return fallback;

  // CR/LF would let `next` inject a second header into the redirect response.
  if (/[\r\n]/.test(next)) return fallback;

  return next;
}
