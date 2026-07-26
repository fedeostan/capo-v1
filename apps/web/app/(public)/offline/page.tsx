import { publicCatalog } from '@/lib/i18n';

// Offline fallback served by the service worker when a navigation fails.
// Reads the locale hint from the cookie only — no DB, no network: this page has
// to render when there IS no network.
export default async function OfflinePage() {
  const { t } = await publicCatalog();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-4xl">📡</p>
      <h1 className="text-lg font-semibold">{t.offline.title}</h1>
      <p className="text-sm text-zinc-500">{t.offline.text}</p>
    </div>
  );
}
