'use client';

import { useState } from 'react';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import { Sheet } from '@/app/_ui/sheet';

// The row and the sheet ship. The DELETION does not.
//
// Federico's call (2026-08-24): "simply add the button and don't create the
// route yet." So the confirm button is permanently disabled and the sheet says
// why, in a plain sentence, rather than arming itself when the typed name
// matches and then doing nothing. That second version is the one thing this
// must never be: a manager who typed their own company name and tapped a red
// button labelled "delete forever" would reasonably believe the account was
// gone.
//
// `matches` is computed and deliberately unused. It is the gate a later round
// enables rather than designs, and keeping it here means the next person reads
// the rule (case-insensitive, trimmed, against the REAL company name rather
// than a literal) instead of reinventing it.
//
// Context for that later round: Capo has no account deletion anywhere. The
// schema has exactly ONE delete policy in total (push_subscriptions), by
// design — the standing rule is mark-inactive-never-remove, so that "why did
// Capo say that in March" stays answerable. EU right-to-erasure means the gap
// has to close eventually; it is named here rather than left implied.
export function DeleteAccountSheet({ locale, companyName }: { locale: Locale; companyName: string | null }) {
  const t = getCatalog(locale).shell.deleteAccount;
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');

  const matches =
    companyName !== null && typed.trim().toLowerCase() === companyName.trim().toLowerCase();
  void matches;

  function close() {
    setOpen(false);
    // Reset, so reopening never shows a half-typed confirmation from before.
    setTyped('');
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-14 w-full items-center justify-between gap-3 rounded-card bg-danger-quiet px-4 text-callout font-semibold text-danger outline-none transition-colors ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        {t.row}
        <span className="shrink-0 text-caption font-medium opacity-85">{t.cannotUndo}</span>
      </button>

      <Sheet open={open} onClose={close} title={t.title}>
        <h2 className="text-heading font-semibold text-danger">{t.title}</h2>
        <p className="mt-2 text-callout text-fg-muted">{t.body}</p>
        {/* The line that makes the disabled button honest instead of broken. */}
        <p className="mt-2 text-caption text-fg-faint">{t.unavailable}</p>

        <input
          value={typed}
          onChange={e => setTyped(e.target.value)}
          placeholder={companyName ?? t.placeholder}
          aria-label={t.placeholder}
          // text-base, not the caption scale: anything under 16px makes iOS
          // Safari zoom the whole page the moment the field is focused.
          className="mt-3 min-h-12 w-full rounded-control border border-control bg-surface-sunken px-4 text-base text-fg outline-none transition-colors ease-out focus:border-brand"
        />

        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={close}
            className="min-h-11 rounded-full bg-surface-sunken text-callout font-semibold text-fg outline-none transition-colors ease-out focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {t.cancel}
          </button>
          {/* disabled, never a no-op onClick — same rule as the top bar's
              search. A control that announces itself as working to a screen
              reader while doing nothing is worse than one that says it cannot.
              The solid pair is used rather than themed --danger because white
              on the DARK themed danger fails contrast badly; the -solid tokens
              are pinned identically in both themes for exactly this. */}
          <button
            type="button"
            disabled
            className="min-h-11 rounded-full bg-danger-solid text-callout font-semibold text-on-solid opacity-45 disabled:pointer-events-none"
          >
            {t.confirm}
          </button>
        </div>
      </Sheet>
    </>
  );
}
