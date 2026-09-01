'use client';

import { useId, useState } from 'react';
import { Field } from '@capo/ui/field';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';

// The password box on every signed-out screen: login, registar, nova-password.
//
// It exists because a password field is the one input in the product where
// somebody cannot see what they typed — on a phone, often outdoors, often with
// a keyboard whose language is not the one they are typing in. Without the eye,
// a typo and a wrong password are the same event: "email ou palavra-passe
// incorretos", with no way to tell which.
//
// It is a client component ONLY for the toggle. Everything the form actually
// submits — name, required, minLength, autoComplete — stays on a plain <input>,
// so a page whose JavaScript has not arrived yet still signs somebody in; the
// eye is simply not there yet. Same reasoning as LanguageSwitch's plain POSTs.
//
// One field per component instance: `name` is always "password" because all
// three screens post exactly that, and none of them asks for it twice.

// The input mirrors the shared Input's classes (field.tsx's CONTROL) by hand:
// the eye needs pr-12 so typed text never runs underneath it, and Input takes
// no className on purpose. If CONTROL changes shape, change this too.
const INPUT = [
  'w-full min-h-12 rounded-control py-2 pl-3 pr-12 text-body',
  'bg-surface-sunken text-fg',
  'border border-control',
  'transition-[border-color,box-shadow] ease-out',
  'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
  'disabled:opacity-50',
].join(' ');

function EyeIcon({ off }: { off: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
      {off && <path d="M3 3l18 18" />}
    </svg>
  );
}

export default function PasswordField({
  locale,
  label,
  autoComplete,
  minLength,
}: {
  locale: Locale;
  label: string;
  autoComplete: 'current-password' | 'new-password';
  minLength?: number;
}) {
  const t = getCatalog(locale).auth;
  const [visible, setVisible] = useState(false);
  const inputId = useId();

  return (
    // Field wires label to input with htmlFor rather than a wrapping <label>:
    // the toggle lives inside the field, and a click on it would otherwise
    // also be a click on the label.
    <Field id={inputId} label={label}>
      {a11y => (
        <div className="relative">
          <input
            {...a11y}
            type={visible ? 'text' : 'password'}
            name="password"
            required
            minLength={minLength}
            autoComplete={autoComplete}
            // A revealed password is still a password. Left alone, iOS would
            // capitalise its first letter and autocorrect the rest — silently
            // changing what gets submitted, which is the opposite of the point.
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className={INPUT}
          />
          <button
            // WITHOUT type="button" this submits the form it sits in — the
            // default for a <button> inside a <form>. Do not remove it.
            type="button"
            onClick={() => setVisible(v => !v)}
            aria-label={visible ? t.hidePassword : t.showPassword}
            aria-pressed={visible}
            className="absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-r-control text-fg-muted hover:text-fg focus-visible:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
          >
            <EyeIcon off={visible} />
          </button>
        </div>
      )}
    </Field>
  );
}
