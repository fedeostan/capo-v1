// One field, two controls, no JavaScript.
//
// Before this, both phone inputs in the app asked for a number in international
// format and quietly rejected anything else. That is a fine rule for somebody
// who knows what "international format" means, and an invisible wall for
// everybody else. Argentina made it worse than a wall: WhatsApp writes an
// Argentine mobile as +54 9 <area> <number>, nobody in Argentina writes it that
// way, and a number stored without that 9 breaks every send and every inbound
// match with no error anywhere (2026-08-12).
//
// So the person now picks a flag and types the number they know. The arithmetic
// lives in packages/core/src/channels/phone.ts, is shared with the chat tools,
// and is pinned by `pnpm phone-check`.
//
// NO 'use client' and NO hooks, deliberately. This is two plain form controls
// with `defaultValue`, so it renders inside the server-rendered onboarding form
// and inside the already-client /perfil form without either of them changing
// shape, and it submits correctly before any JavaScript has loaded.
import { Field, Input, Select } from '@capo/ui/field';
import { getCatalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import { defaultCountryFor, PHONE_COUNTRIES, splitE164 } from '@capo/core/channels/phone';

/** The form field the country lands in. The server action pairs it with the
 *  phone field by name, so the two must agree; exported so a caller cannot
 *  spell it differently. */
export const PHONE_COUNTRY_FIELD = 'country';

export function PhoneField({
  id,
  name,
  label,
  locale,
  value,
  hint,
  error,
  required = false,
  autoComplete,
  placeholder,
}: {
  id: string;
  /** Name of the national-number field. Unchanged from what the form posted
   *  before, so no server action has to learn a new key. */
  name: string;
  label: string;
  locale: Locale;
  /** The stored E.164 number, when editing an existing one. */
  value?: string;
  hint?: string;
  error?: string;
  required?: boolean;
  autoComplete?: string;
  placeholder?: string;
}) {
  const t = getCatalog(locale);
  // A number from a country the picker does not offer cannot be split, and must
  // NOT be guessed at: it stays whole in the text field, keeps its `+`, and
  // composeE164 recognises it and passes it through untouched. Anything else
  // would rewrite a working number the first time somebody edited their name.
  const split = value ? splitE164(value) : null;
  const iso = split?.iso ?? defaultCountryFor(locale);
  const national = split ? split.national : (value ?? '');

  return (
    <Field id={id} label={label} hint={hint ?? t.phone.hint} error={error} required={required}>
      {a11y => (
        <div className="flex gap-2">
          {/* Native <select>, for the reason packages/ui/src/field.tsx gives:
              it is the phone's own picker, it works offline, and it needs no
              focus trap. Fixed width so the number keeps the room it needs. */}
          <span className="w-28 shrink-0">
            <Select name={PHONE_COUNTRY_FIELD} defaultValue={iso} aria-label={t.phone.country}>
              {PHONE_COUNTRIES.map(country => (
                <option key={country.iso} value={country.iso} title={t.phone.countries[country.iso]}>
                  {`${country.flag} +${country.dial}`}
                </option>
              ))}
            </Select>
          </span>
          <span className="min-w-0 flex-1">
            <Input
              {...a11y}
              type="tel"
              name={name}
              inputMode="tel"
              autoComplete={autoComplete}
              defaultValue={national}
              placeholder={placeholder}
            />
          </span>
        </div>
      )}
    </Field>
  );
}
