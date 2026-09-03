// The ONE phone normalizer. Nothing else in this repo may hold a second copy.
//
// A phone number in Capo is not a display string: it is an IDENTITY. Outbound,
// `toSendTarget()` strips the leading `+` and hands the rest to Meta verbatim as
// the wa_id. Inbound, the webhook resolves a sender by matching `+<wa_id>`
// against `profiles.phone` / `workers.phone` as an EXACT STRING. So a number
// stored in a shape WhatsApp does not use is not "slightly wrong" — that person
// receives nothing and is heard by nobody, with no error anywhere.
//
// This happened. On 2026-08-12 the manager's own number was re-saved on /perfil
// without the Argentine 9 and every inbound message stopped resolving. Nothing
// in the app said so; the messages simply arrived and were dropped as coming
// from a stranger.
//
// ── Argentina ───────────────────────────────────────────────────────────────
// WhatsApp identifies an Argentine mobile as +54 9 <area> <subscriber>: a 9
// inserted right after the country code. That form is what a wa_id carries and
// what must be stored. Argentines do NOT write it that way. They write
// +54 11 7887 6189, or locally 011 15 7887 6189, where the leading 0 is the
// trunk prefix and the 15 is the legacy mobile marker that the 9 replaced.
// Both of those, and the modern form, have to land on the same string.
//
// This file is pure: no imports, no I/O, no clock, no locale catalog. It is
// imported by the web forms, by the chat tools, and by `scripts/phone-check.mts`
// (credential-free, in CI), which pins every case below.

export type PhoneCountryIso = 'PT' | 'ES' | 'AR' | 'BR' | 'US';

export type PhoneCountry = {
  iso: PhoneCountryIso;
  /** Country calling code, digits only, no `+`. */
  dial: string;
  flag: string;
};

/** The countries the picker offers. Country NAMES are deliberately not here:
 *  they are copy, they belong in the @capo/i18n catalog, and this file must
 *  stay importable from anywhere without dragging a dictionary along. */
export const PHONE_COUNTRIES: readonly PhoneCountry[] = [
  { iso: 'PT', dial: '351', flag: '\u{1F1F5}\u{1F1F9}' },
  { iso: 'ES', dial: '34', flag: '\u{1F1EA}\u{1F1F8}' },
  { iso: 'AR', dial: '54', flag: '\u{1F1E6}\u{1F1F7}' },
  { iso: 'BR', dial: '55', flag: '\u{1F1E7}\u{1F1F7}' },
  { iso: 'US', dial: '1', flag: '\u{1F1FA}\u{1F1F8}' },
];

/** The same shape both DB check constraints use (0007 for profiles, 0003 for
 *  workers). This is the floor, not the rule: a number can satisfy it and still
 *  be useless as a wa_id, which is what the per-country lengths below are for. */
export const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * How many digits a national number has once the trunk prefix and any legacy
 * marker are gone, and once Argentina's 9 is IN (so AR is 11, not 10).
 *
 * Deliberately a range rather than a regex per country: this is a sanity check
 * that catches a missing or doubled digit, not a numbering-plan validator. Being
 * too strict here means refusing a real person's real number, which is worse
 * than storing one the provider will reject with a visible error.
 */
const NATIONAL_LENGTH: Record<PhoneCountryIso, { min: number; max: number }> = {
  PT: { min: 9, max: 9 },
  ES: { min: 9, max: 9 },
  AR: { min: 11, max: 11 },
  BR: { min: 10, max: 11 },
  US: { min: 10, max: 10 },
};

/** Countries whose national numbers are written with a leading 0 trunk prefix
 *  that is dropped in the international form. The US is not one of them: its
 *  trunk prefix is 1, and stripping a leading digit there would eat an area
 *  code. */
const TRUNK_ZERO: ReadonlySet<PhoneCountryIso> = new Set<PhoneCountryIso>(['PT', 'ES', 'AR', 'BR']);

const BY_ISO = new Map<PhoneCountryIso, PhoneCountry>(PHONE_COUNTRIES.map(c => [c.iso, c]));

/** Longest dial code first, so `+351` is never read as `+34` and `+54` is never
 *  read as `+5`. */
const BY_DIAL_LENGTH = [...PHONE_COUNTRIES].sort((a, b) => b.dial.length - a.dial.length);

export function phoneCountry(iso: string): PhoneCountry | null {
  return BY_ISO.get(iso as PhoneCountryIso) ?? null;
}

/** Narrow an untrusted form value to a country we actually offer. */
export function asPhoneCountry(value: string): PhoneCountryIso | null {
  return BY_ISO.has(value as PhoneCountryIso) ? (value as PhoneCountryIso) : null;
}

/**
 * Which flag the picker starts on. The user's own language dial is the only
 * signal available before they have typed anything, and it is a good one: a
 * manager reading Portuguese is overwhelmingly in Portugal.
 *
 * Anything unrecognised falls back to Portugal, which is the product's home
 * market and the value the two forms have effectively been hard-coded to since
 * the first normalizer prefixed `+351`.
 */
export function defaultCountryFor(locale: string): PhoneCountryIso {
  if (locale.startsWith('es')) return 'ES';
  if (locale.startsWith('en')) return 'US';
  return 'PT';
}

/** Everything a human puts between digits: spaces, dashes, dots, brackets, and
 *  the non-breaking space a phone keyboard or a paste can smuggle in. */
function digitsOnly(raw: string): string {
  return raw.replace(/[^\d]/g, '');
}

/**
 * The Argentine rule, in one place.
 *
 * In:  a national part, digits only, trunk 0 already gone.
 * Out: the same number with the legacy `15` removed and the modern 9 in front,
 *      or null when it is not a length any of that can apply to.
 *
 * Idempotent by construction: a number that already carries the 9 has it taken
 * off at the top and put back at the bottom, unchanged.
 */
function argentineNational(digits: string): string | null {
  let rest = digits;
  // A leading 9 on an over-length number is the modern mobile marker. No
  // Argentine area code begins with 9, so this cannot eat a real area code.
  if (rest.length > 10 && rest.startsWith('9')) rest = rest.slice(1);

  // The legacy marker: `15` sitting between the area code and the subscriber
  // number, which makes the national part 12 digits instead of 10. Area codes
  // are 2, 3 or 4 digits, so the 15 can only be at one of three offsets. First
  // match wins, and only when removing it produces exactly 10 digits.
  if (rest.length === 12) {
    for (const at of [2, 3, 4]) {
      if (rest.slice(at, at + 2) === '15') {
        rest = rest.slice(0, at) + rest.slice(at + 2);
        break;
      }
    }
  }

  if (rest.length !== 10) return null;
  return `9${rest}`;
}

/**
 * A country and whatever the person typed into the national field, to the E.164
 * string that gets stored. Returns null when the result is not a number worth
 * storing, and the caller shows its existing validation error.
 *
 * The escape hatch: a value that starts with `+` and does NOT begin with the
 * selected country's dial code is treated as an already-international number
 * and passed through (canonicalized). Without it, a manager with a French
 * number would have the picker silently glue `+351` onto the front of it.
 */
export function composeE164(iso: string, national: string): string | null {
  const country = phoneCountry(iso);
  if (!country) return null;

  const typed = national.trim();

  // Somebody typed the whole international number into the national box.
  if (typed.startsWith('+')) {
    const all = digitsOnly(typed);
    if (all.startsWith(country.dial)) {
      return fromNational(country, all.slice(country.dial.length));
    }
    const other = `+${all}`;
    return E164.test(other) ? canonicalizeE164(other) : null;
  }

  let rest = digitsOnly(typed);
  if (!rest) return null;

  // `00351…` and `351…`, both of which people type. The bare form is only
  // stripped when what remains is a plausible national length for that country,
  // so a Portuguese number that happens to start with the digits 351 is safe.
  if (rest.startsWith(`00${country.dial}`)) rest = rest.slice(country.dial.length + 2);
  else if (rest.startsWith(country.dial) && plausible(country.iso, afterTrunk(country.iso, rest.slice(country.dial.length)))) {
    rest = rest.slice(country.dial.length);
  }

  return fromNational(country, rest);
}

function afterTrunk(iso: PhoneCountryIso, digits: string): string {
  return TRUNK_ZERO.has(iso) && digits.startsWith('0') ? digits.slice(1) : digits;
}

function plausible(iso: PhoneCountryIso, national: string): boolean {
  const normalized = iso === 'AR' ? argentineNational(national) : national;
  if (normalized === null) return false;
  const { min, max } = NATIONAL_LENGTH[iso];
  return normalized.length >= min && normalized.length <= max;
}

function fromNational(country: PhoneCountry, digits: string): string | null {
  const trimmed = afterTrunk(country.iso, digits);
  const national = country.iso === 'AR' ? argentineNational(trimmed) : trimmed;
  if (national === null) return null;

  const { min, max } = NATIONAL_LENGTH[country.iso];
  if (national.length < min || national.length > max) return null;

  const e164 = `+${country.dial}${national}`;
  return E164.test(e164) ? e164 : null;
}

/**
 * An already-international number to the shape WhatsApp uses.
 *
 * This is the door the CHAT tools come through: the model has produced a
 * `+…` string from what the manager dictated, zod has checked it against E164,
 * and the only thing still capable of being wrong in a way nobody will notice
 * is the Argentine 9.
 *
 * Everything that is not a `+54` number passes through untouched, and a `+54`
 * number this cannot make sense of passes through untouched too: refusing a
 * number here would turn a possible mistake into a certain failure. Idempotent,
 * so it is safe to run on a value that has already been through it.
 */
export function canonicalizeE164(e164: string): string {
  if (!E164.test(e164)) return e164;
  if (!e164.startsWith('+54')) return e164;
  const national = argentineNational(e164.slice(3));
  if (national === null) return e164;
  const out = `+54${national}`;
  return E164.test(out) ? out : e164;
}

/**
 * A stored number back into the two fields the form edits.
 *
 * Argentina is shown WITHOUT the 9, because the 9 is not part of the number
 * anybody in Argentina knows: seeing it would read as a typo and invite a
 * manager to "fix" it. Composing the same value again puts it back, and
 * `pnpm phone-check` pins that round trip.
 *
 * Returns null for a country outside the picker, which the form must render as
 * the whole `+…` string in the text field rather than guessing a flag.
 */
export function splitE164(e164: string): { iso: PhoneCountryIso; national: string } | null {
  if (!E164.test(e164)) return null;
  const digits = e164.slice(1);
  for (const country of BY_DIAL_LENGTH) {
    if (!digits.startsWith(country.dial)) continue;
    const rest = digits.slice(country.dial.length);
    if (country.iso === 'AR') {
      if (rest.startsWith('9') && rest.length === 11) return { iso: 'AR', national: rest.slice(1) };
      // A +54 number with no 9 is not a shape this product should be storing,
      // but it can exist from before the picker. Show it as it is.
      return { iso: 'AR', national: rest };
    }
    const { min, max } = NATIONAL_LENGTH[country.iso];
    if (rest.length < min || rest.length > max) continue;
    return { iso: country.iso, national: rest };
  }
  return null;
}
