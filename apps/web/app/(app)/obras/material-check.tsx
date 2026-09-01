'use client';

import { useState, useTransition } from 'react';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import { setMaterialCheck } from './material-check-actions';

// The tick on today's materials list (issue #154).
//
// TWO CHIPS, NOT A CHECKBOX, because there are three states and a checkbox can
// only draw two. "On site" and "missing" are both ANSWERS and both worth
// seeing at a glance — a single box would make "missing" indistinguishable
// from "not looked at yet", which is the distinction the whole walk-around
// exists to produce. Tapping the chip that is already active withdraws the
// answer; that is an UPDATE to 'unknown', never a delete (0044 has no DELETE
// policy, uniform with "forget this memory" and the translation undo).
//
// `min-h-11 min-w-11` is 44px — the floor for a man in work gloves standing on
// a building site, which is the design target rather than a mouse pointer.
//
// The locale is passed as a plain string rather than the catalog, for the same
// reason MaterialsEditor does it: the catalog holds interpolation functions,
// which cannot cross the server→client boundary.

export type MaterialCheckState = 'on_site' | 'missing';

export default function MaterialCheck({
  obraId,
  material,
  state,
  locale,
}: {
  obraId: string | null;
  material: string;
  /** null = nothing recorded for today yet. */
  state: MaterialCheckState | null;
  locale: Locale;
}) {
  const t = getCatalog(locale).screens.materials;
  // Optimistic: the chip fills on tap and the server action runs behind it. A
  // manager walking a site taps a dozen of these in a row and must not wait for
  // a round trip on a building-site connection between each one.
  const [shown, setShown] = useState<MaterialCheckState | null>(state);
  const [failed, setFailed] = useState(false);
  const [pending, startTransition] = useTransition();

  function choose(next: MaterialCheckState) {
    const previous = shown;
    const value = shown === next ? null : next;
    setShown(value);
    setFailed(false);
    startTransition(async () => {
      try {
        await setMaterialCheck(obraId, material, value ?? 'unknown');
      } catch {
        // Reverted, and SAID. A tick that silently did not land is the one
        // outcome a check list must never produce: the manager would leave the
        // site believing they had recorded something they had not.
        setShown(previous);
        setFailed(true);
      }
    });
  }

  const chip = (value: MaterialCheckState, label: string, tone: string) => (
    <button
      type="button"
      onClick={() => choose(value)}
      disabled={pending}
      aria-pressed={shown === value}
      aria-label={`${label} — ${material}`}
      className={`min-h-11 min-w-11 rounded-chip border px-3 text-caption font-medium transition-colors ease-out outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50 ${
        shown === value ? tone : 'border-hairline text-fg-muted hover:bg-surface-hover'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1">
        {chip('on_site', t.onSite, 'border-success bg-success-quiet text-success')}
        {chip('missing', t.missing, 'border-warn bg-warn-quiet text-warn')}
      </div>
      {failed && (
        <p role="status" className="text-micro text-danger">
          {t.checkFailed}
        </p>
      )}
    </div>
  );
}
