import type { MetadataRoute } from 'next';
import { getCatalog } from '@capo/i18n/catalog';
import { publicLocale } from '@/lib/i18n';

// Low value, low risk: an already-installed PWA does not refetch its manifest,
// so this only affects the language of a FRESH install.
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const t = getCatalog(await publicLocale());
  return {
    name: t.meta.appName,
    short_name: t.meta.appName,
    description: t.meta.appDescription,
    id: '/',
    start_url: '/',
    display: 'standalone',
    lang: t.meta.htmlLang,
    background_color: '#ffffff',
    theme_color: '#ea580c',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    // Long-press the installed icon → jump straight to the two things a
    // manager opens the app for outside of talking to Capo: what is on today,
    // and what has to be bought before tomorrow.
    shortcuts: [
      { name: t.nav.tasks, short_name: t.nav.tasks, url: '/tarefas' },
      { name: t.screens.materials.title, short_name: t.nav.materials, url: '/materiais' },
    ],
  };
}
