import { redirect } from 'next/navigation';

// Kept as a route rather than deleted. This address is in the wild — phone home
// screens, bookmarks, and any link Capo itself has written into a chat thread —
// and a 404 for a screen that merely MOVED is the kind of small betrayal a
// manager reads as the app being broken.
//
// The screen itself now lives behind the switch on /obras; see that file for
// why Materiais left the tab bar.
export default function MateriaisPage() {
  redirect('/obras?vista=materiais');
}
