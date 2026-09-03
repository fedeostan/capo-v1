// Phone check — the one normalizer, pinned.
//
// Why this needs a gate of its own, when a wrong phone number sounds like the
// most obviously visible bug in the world: it is not visible AT ALL.
//
//   Outbound, `toSendTarget()` strips the `+` and hands the rest to Meta as the
//   wa_id. Inbound, the webhook resolves a sender by matching `+<wa_id>` against
//   `profiles.phone` / `workers.phone` as an exact string.
//
// So a number stored in a shape WhatsApp does not use produces no error, no log
// line and no failed row. The person simply receives nothing and is heard by
// nobody, and every screen in the app goes on showing their number as if it
// were fine. That happened on 2026-08-12: the manager's own number was re-saved
// without the Argentine 9 and inbound WhatsApp went totally silent.
//
// Everything here is pure, so it needs no credentials, no network and no model,
// and runs in CI on every PR. Run with `pnpm phone-check`.
//
// Exit 0 = green, 1 = at least one failure.

import {
  asPhoneCountry,
  canonicalizeE164,
  composeE164,
  defaultCountryFor,
  E164,
  PHONE_COUNTRIES,
  splitE164,
} from '@capo/core/channels/phone';
import { getCatalog } from '@capo/i18n/catalog';
import { LOCALES } from '@capo/i18n/locale';

let failures = 0;
const lines: string[] = [];

function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures += 1;
  lines.push(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function eq(name: string, actual: unknown, expected: unknown) {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

// ── the country list ────────────────────────────────────────────────────────
eq('five countries are offered', PHONE_COUNTRIES.length, 5);
eq(
  'in the order the brief fixes: PT, ES, AR, BR, US',
  PHONE_COUNTRIES.map(c => c.iso).join(','),
  'PT,ES,AR,BR,US',
);
check(
  'every dial code is digits only, with no plus',
  PHONE_COUNTRIES.every(c => /^\d{1,3}$/.test(c.dial)),
);
check('no two countries share a dial code', new Set(PHONE_COUNTRIES.map(c => c.dial)).size === 5);
check(
  'every country has a name in every language, so the picker can never render a blank row',
  LOCALES.every(locale => PHONE_COUNTRIES.every(c => (getCatalog(locale).phone.countries[c.iso] ?? '').length > 0)),
);
eq('an unknown ISO from a form post is refused', asPhoneCountry('XX'), null);
eq('a known one is narrowed', asPhoneCountry('AR'), 'AR');

eq('a Portuguese manager starts on Portugal', defaultCountryFor('pt-PT'), 'PT');
eq('a Spanish one starts on Spain', defaultCountryFor('es-ES'), 'ES');
eq('an English one starts on the United States', defaultCountryFor('en-US'), 'US');
eq('anything unrecognised falls back to the home market', defaultCountryFor('fr-FR'), 'PT');

// ── Argentina, the case this whole file exists for ──────────────────────────
// Federico's own number. WhatsApp knows it as +5491178876189 and nothing else
// will do. All three of these are ways a real person writes it.
const FEDE = '+5491178876189';
for (const typed of [
  '11 7887 6189',
  '1178876189',
  '011 15 7887 6189',
  '011157887 6189',
  '+54 11 7887 6189',
  '+54 9 11 7887 6189',
  '+5491178876189',
  '(011) 15-7887-6189',
]) {
  eq(`AR: "${typed}"`, composeE164('AR', typed), FEDE);
}

check(
  'the composed Argentine number is a valid E.164 string',
  E164.test(FEDE) && FEDE.length === 14,
);

// A three- and a four-digit area code, so the legacy 15 removal is not pinned
// to Buenos Aires alone.
eq('AR: a 3-digit area code with the legacy 15', composeE164('AR', '0261 15 555 4444'), '+5492615554444');
eq('AR: a 4-digit area code with the legacy 15', composeE164('AR', '02966 15 55 4444'), '+5492966554444');
eq('AR: the same 3-digit number written modern', composeE164('AR', '261 555 4444'), '+5492615554444');

// ── the other four countries ────────────────────────────────────────────────
eq('PT: a bare mobile', composeE164('PT', '912 345 678'), '+351912345678');
eq('PT: the same with the country code typed in anyway', composeE164('PT', '+351 912 345 678'), '+351912345678');
eq('PT: the international prefix spelled 00', composeE164('PT', '00351912345678'), '+351912345678');
eq('PT: a landline', composeE164('PT', '212 345 678'), '+351212345678');
eq('ES: a bare mobile', composeE164('ES', '612 345 678'), '+34612345678');
eq('ES: with the country code', composeE164('ES', '+34 612 345 678'), '+34612345678');
eq('BR: an 11-digit mobile with the trunk 0', composeE164('BR', '011 98765 4321'), '+5511987654321');
eq('BR: a 10-digit landline', composeE164('BR', '11 3900 1234'), '+551139001234');
eq('US: ten digits, punctuated the way Americans write them', composeE164('US', '(555) 123-4567'), '+15551234567');
eq('US: with the leading 1', composeE164('US', '1 555 123 4567'), '+15551234567');

// A Brazilian area code that IS the dial code (Rio Grande do Sul is 55). The
// bare-dial strip must not eat it, which is the whole reason that branch checks
// the remaining length before cutting.
eq('BR: area code 55 survives the dial-code strip', composeE164('BR', '55 99999 8888'), '+5555999998888');

// ── junk is refused, never guessed ──────────────────────────────────────────
for (const junk of ['', '   ', 'abc', '12', '9123456789012345678', '+', '0']) {
  eq(`refuses ${JSON.stringify(junk)}`, composeE164('PT', junk), null);
}
eq('a PT number one digit short is refused', composeE164('PT', '91234567'), null);
eq('a PT number one digit long is refused', composeE164('PT', '9123456789'), null);
eq('a US number one digit short is refused', composeE164('US', '555123456'), null);
eq('an unknown country is refused outright', composeE164('XX', '912345678'), null);

// ── the escape hatch ────────────────────────────────────────────────────────
// A country the picker does not offer must still be storable, or the picker
// becomes a wall for exactly the people it was meant to help.
eq(
  'a full international number from another country passes through',
  composeE164('PT', '+44 7700 900123'),
  '+447700900123',
);
eq('and is still refused when it is not a valid E.164 string', composeE164('PT', '+44 77'), null);

// ── canonicalizeE164: the door the chat tools come through ──────────────────
eq('an Argentine number missing the 9 gains it', canonicalizeE164('+541178876189'), FEDE);
eq('one that already has it is unchanged', canonicalizeE164(FEDE), FEDE);
eq('the legacy 15 form is repaired too', canonicalizeE164('+54111578876189'), FEDE);
eq('a Portuguese number is untouched', canonicalizeE164('+351912345678'), '+351912345678');
eq('a Brazilian number is untouched', canonicalizeE164('+5511987654321'), '+5511987654321');
eq('a US number is untouched', canonicalizeE164('+15551234567'), '+15551234567');
eq('a +54 number of a length nothing can explain is left alone, never mangled', canonicalizeE164('+5412345'), '+5412345');
eq('a string that is not E.164 at all passes through unchanged', canonicalizeE164('nonsense'), 'nonsense');

// Idempotency, stated as a property rather than as three more cases: this
// function runs on every add_worker and every update_worker, and a second pass
// happens whenever a manager corrects a name and leaves the number alone.
for (const country of PHONE_COUNTRIES) {
  const once = composeE164(country.iso, country.iso === 'AR' ? '11 7887 6189' : sample(country.iso));
  check(`compose then canonicalize is a fixed point for ${country.iso}`, once !== null && canonicalizeE164(once) === once, String(once));
  check(
    `and canonicalize is idempotent for ${country.iso}`,
    once !== null && canonicalizeE164(canonicalizeE164(once)) === canonicalizeE164(once),
  );
}

function sample(iso: string): string {
  switch (iso) {
    case 'PT':
      return '912345678';
    case 'ES':
      return '612345678';
    case 'BR':
      return '11987654321';
    default:
      return '5551234567';
  }
}

// ── splitE164: the round trip the edit form depends on ──────────────────────
// Getting this wrong is worse than getting compose wrong: it corrupts a number
// that was already correct, the moment somebody opens the form to change their
// NAME.
{
  const split = splitE164(FEDE);
  eq('an Argentine number splits to its flag', split?.iso, 'AR');
  eq('and is shown WITHOUT the 9, which is the number people know', split?.national, '1178876189');
  eq('and composing it again puts the 9 back', composeE164('AR', split?.national ?? ''), FEDE);
}

for (const stored of ['+351912345678', '+34612345678', FEDE, '+5511987654321', '+15551234567', '+551139001234']) {
  const split = splitE164(stored);
  check(`${stored} splits`, split !== null);
  eq(`${stored} round-trips through the form unchanged`, split && composeE164(split.iso, split.national), stored);
}

eq('a country outside the picker does not split, so the form keeps it whole', splitE164('+447700900123'), null);
eq('nor does a string that is not E.164', splitE164('912345678'), null);

// ── report ──────────────────────────────────────────────────────────────────
console.log(lines.join('\n'));
console.log(`\nPhone check: ${lines.length - failures}/${lines.length} passed; failures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
