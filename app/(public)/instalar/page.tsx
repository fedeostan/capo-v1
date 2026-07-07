import type { Metadata } from 'next';
import InstallGuide from './install-guide';

export const metadata: Metadata = { title: 'Instalar — Capo' };

// Final onboarding step: get Capo onto the home screen. Session-gated by the
// proxy; static shell otherwise (the guide adapts per platform client-side).
export default function InstalarPage() {
  return (
    <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-6 px-6 pb-16">
      <div className="space-y-2 text-center">
        <p className="text-4xl">📲</p>
        <h1 className="text-2xl font-semibold">Instala o Capo</h1>
        <p className="text-sm text-zinc-500">
          Com o Capo no ecrã principal, abres a app num toque — como o WhatsApp.
        </p>
      </div>
      <InstallGuide />
    </div>
  );
}
