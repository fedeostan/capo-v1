'use client';

import { useEffect, useRef } from 'react';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import { THEMES, type Theme } from '@/lib/theme-shared';
import { setTheme } from './actions';

// The appearance pills: tapping one repaints the whole app IMMEDIATELY, Save is
// what persists the choice into the capo_theme cookie.
//
// The two used to be the same act — you could not see what Dark looked like
// without submitting the form — which also made "did that save?" unanswerable,
// because the only evidence a save had happened was the thing a tap should have
// done on its own.
//
// ABANDON BEHAVIOUR — chosen deliberately: leaving /perfil without pressing
// Save REVERTS the app to the saved theme. A preview that silently outlives the
// screen it was made on is indistinguishable from a save that worked, which is
// precisely the confusion this change exists to remove. The cookie stays the
// single source of truth; everything here is a temporary overlay on it.
//
// Deliberately still a plain <form action={setTheme}>: with JavaScript not yet
// running (a cold PWA on a slow phone) the tap no longer previews, but the pill
// still checks and Save still persists. The preview degrades; the control does
// not break.

/** Swap the theme class on <html>.
 *
 *  Only the three theme classes are touched — never the whole className — since
 *  the font variables and `h-full antialiased` share that attribute. React
 *  reconciles className against the value it last RENDERED, so the class the
 *  root layout stamps after a save still wins on the next render. That is the
 *  right precedence: the cookie is the truth, this is a preview over it. */
function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.remove(...THEMES);
  root.classList.add(theme);
}

export default function ThemePills({ current, locale }: { current: Theme; locale: Locale }) {
  const t = getCatalog(locale);

  // The saved theme, kept fresh rather than captured once: after a save the
  // server hands down a new `current`, and a revert to a stale capture would
  // undo the very save that just happened.
  const saved = useRef(current);
  useEffect(() => {
    saved.current = current;
  }, [current]);

  // Once the form is submitted the server-rendered class is authoritative, so
  // the revert must not fire — setTheme redirects, and a redirect can unmount
  // this component before the new class lands.
  const submitted = useRef(false);

  useEffect(
    () => () => {
      if (!submitted.current) applyTheme(saved.current);
    },
    [],
  );

  return (
    <form
      action={setTheme}
      onSubmit={() => {
        submitted.current = true;
      }}
      className="space-y-2"
    >
      <div className="flex gap-2">
        {/* Indexing themeOption with a Theme is the tripwire that keeps
            @capo/i18n and lib/theme-shared.ts from drifting apart — widen one
            union without the other and tsc fails here. */}
        {THEMES.map(option => (
          <label key={option} className="flex-1">
            <input
              type="radio"
              name="tema"
              value={option}
              defaultChecked={option === current}
              onChange={() => applyTheme(option)}
              className="peer sr-only"
            />
            <span className="block cursor-pointer rounded-lg border border-control py-2 text-center text-callout peer-checked:border-brand peer-checked:bg-brand-quiet peer-checked:font-semibold">
              {t.settings.themeOption[option]}
            </span>
          </label>
        ))}
      </div>
      <button
        type="submit"
        className="w-full rounded-lg border border-control py-2 text-callout font-semibold hover:bg-surface-hover"
      >
        {t.common.save}
      </button>
    </form>
  );
}
