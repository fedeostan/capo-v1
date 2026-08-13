// Appearance constants shared by server and client code.
//
// Split out of lib/theme.ts because that module imports next/headers, which can
// never be pulled into a client bundle — exactly the split lib/i18n-shared.ts
// made, and the one lib/theme.ts's own header comment asked for. The client
// that needs this is perfil/theme-pills.tsx, which renders the option list and
// applies the live preview. lib/theme.ts re-exports everything here, so server
// callers keep importing from a single place.

/** The three appearance states, in display order.
 *
 *  The value IS the class name stamped on <html> by the root layout, which is
 *  what lets the client preview swap states with classList and no lookup
 *  table. globals.css encodes the same three states in CSS — change one and
 *  you must change the other. */
export const THEMES = ['light', 'dark', 'system'] as const;
export type Theme = (typeof THEMES)[number];
