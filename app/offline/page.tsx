// Offline fallback served by the service worker when a navigation fails.
// Static on purpose: it must be precacheable and honest — no stale data.
export default function OfflinePage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-4xl">📡</p>
      <h1 className="text-lg font-semibold">Sem ligação</h1>
      <p className="text-sm text-zinc-500">
        O Capo precisa de internet para mostrar dados atualizados. Verifica a ligação e tenta de
        novo.
      </p>
    </div>
  );
}
