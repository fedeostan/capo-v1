// Browser stand-in for Node's `process`, needed only because two of the
// synced components import next/link and next/navigation.
//
// Next's client runtime reads build-time feature flags — process.env.
// __NEXT_CACHE_COMPONENTS, __NEXT_ROUTER_BASEPATH, NEXT_RUNTIME and friends.
// Inside a Next build its compiler substitutes each one with a literal. Outside
// one they survive as real property reads on a `process` object the browser
// does not have, so the FIRST such read throws ReferenceError at module scope
// and the whole bundle fails to evaluate — which presents as every component
// being missing from window.Capo, not as a routing problem.
//
// Leaving env EMPTY is the correct answer rather than a shortcut: an unset
// __NEXT_* flag is exactly what a Next app that has not opted into those
// experimental features has. (process.env.NODE_ENV never reaches here — esbuild
// replaces it with a literal at build time.)
//
// `??=` so a host that already provides a real process keeps it.
declare global {
  // eslint-disable-next-line no-var
  var process: { env: Record<string, string | undefined> } | undefined;
}

globalThis.process ??= { env: {} };

export {};
