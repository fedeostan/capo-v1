import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Capo',
    short_name: 'Capo',
    description: 'O teu capataz virtual',
    id: '/',
    start_url: '/',
    display: 'standalone',
    lang: 'pt-PT',
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
      { name: 'Hoje', short_name: 'Hoje', url: '/hoje' },
      { name: 'Materiais para amanhã', short_name: 'Materiais', url: '/materiais' },
    ],
  };
}
