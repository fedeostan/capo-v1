import type { MetadataRoute } from 'next';
import { siteUrl } from '@/lib/site-url';

// `/dia` is disallowed for the same reason its page sets noindex/nofollow: the
// URL carries a bearer token, so a crawler that follows one out of a scraped
// chat export puts a live credential in somebody else's logs. Said in both
// places on purpose — a crawler that ignores robots.txt still reads the meta
// tag, and a crawler that never fetches the page never sees it.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/api/', '/dia'] },
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
