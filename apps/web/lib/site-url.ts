// The canonical site URL for links embedded in outbound emails / OAuth
// redirects (NOT for redirects within a request handler — use the request's
// own origin there). Read lazily inside the function: NEXT_PUBLIC_SITE_URL
// won't exist until a production domain is configured (docs/human-todo.md),
// and VERCEL_PROJECT_PRODUCTION_URL only exists at runtime on Vercel.
export function siteUrl(): string {
  if (process.env.NEXT_PUBLIC_SITE_URL) return process.env.NEXT_PUBLIC_SITE_URL;
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return 'http://localhost:3000';
}
