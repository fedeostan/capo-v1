// The knowledge lookup runs an embedding call plus a hybrid query, so this is
// the one screen in the app with a visible wait. A skeleton beats a frozen tab.
export default function Loading() {
  return (
    <div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col">
      <header className="border-b border-zinc-500/20 px-4 py-3">
        <div className="h-6 w-24 animate-pulse rounded bg-zinc-500/15" />
        <div className="mt-1 h-3 w-40 animate-pulse rounded bg-zinc-500/10" />
      </header>
      <main className="flex-1 space-y-3 px-4 py-4">
        {[0, 1, 2].map(i => (
          <div key={i} className="space-y-2 rounded-xl border border-zinc-500/20 p-3">
            <div className="h-3 w-32 animate-pulse rounded bg-zinc-500/15" />
            <div className="h-3 w-full animate-pulse rounded bg-zinc-500/10" />
            <div className="h-3 w-4/5 animate-pulse rounded bg-zinc-500/10" />
          </div>
        ))}
      </main>
    </div>
  );
}
