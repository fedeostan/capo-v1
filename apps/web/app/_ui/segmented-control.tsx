'use client';

// One component for the four separate pill implementations: the /tarefas
// filter chips, the theme pills, the language pills on /perfil, and the
// onboarding language picker.
//
// THE RADIO INPUTS ARE LOAD-BEARING AND MUST NOT BECOME BUTTONS.
// theme-pills.tsx and onboarding/page.tsx are plain <form>s styled with
// peer-checked precisely so that a cold PWA on a slow phone — which is most
// of the time this is actually used — can still select and save before any
// JavaScript has run. onChange only ENHANCES that; it never replaces it.
// Arrow-key navigation between radios in a named group is native browser
// behaviour, so it comes free from this markup.
import type { ChangeEvent } from 'react';

export function SegmentedControl({
  name,
  legend,
  value,
  options,
  onChange,
}: {
  name: string;
  /** Spoken to a screen reader as the question these options answer. */
  legend: string;
  /**
   * Sets the INITIAL selection only — it is read once, into `defaultChecked`,
   * and changing it after mount will not move the rendered pill. That is
   * deliberate (see the file banner): the radios must select and save from
   * plain HTML before any JavaScript runs, which a fully controlled `checked`
   * would fight. A caller that needs to force a different selection should
   * remount the control with a new `key`, not rely on this prop reacting.
   */
  value: string;
  options: { value: string; label: string }[];
  onChange?: (value: string) => void;
}) {
  function handle(e: ChangeEvent<HTMLInputElement>) {
    onChange?.(e.target.value);
  }

  return (
    <fieldset className="min-w-0">
      <legend className="sr-only">{legend}</legend>
      <div className="flex gap-2 overflow-x-auto">
        {options.map(option => (
          <label
            key={option.value}
            className="min-h-11 shrink-0 cursor-pointer"
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              defaultChecked={option.value === value}
              onChange={handle}
              className="peer sr-only"
            />
            <span
              className={[
                'flex min-h-11 items-center rounded-full border px-4 text-callout',
                'border-control text-fg-muted bg-surface',
                'transition-colors ease-out hover:bg-surface-hover',
                // Two signals, not one: the selected pill changes colour AND
                // weight, so it survives a colour-vision deficiency.
                'peer-checked:border-brand peer-checked:bg-brand peer-checked:text-on-brand peer-checked:font-semibold',
                'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus',
              ].join(' ')}
            >
              {option.label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
