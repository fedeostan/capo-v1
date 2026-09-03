'use client';

// The two editable cards on /perfil. useActionState rather than a redirect
// round-trip so a validation error lands next to the field that caused it and
// the typed value survives.
import { useActionState } from 'react';
import { Button } from '@capo/ui/button';
import { Field, Input } from '@capo/ui/field';
import { getCatalog, type Catalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import { PhoneField } from '@/app/_ui/phone-field';
import { updateCompanyName, updateProfile, type FormState } from './actions';

function Feedback({ state, t }: { state: FormState; t: Catalog }) {
  if (!state) return null;
  return state.ok ? (
    <p className="text-caption text-success">{t.settings.saved}</p>
  ) : (
    // The error text is produced server-side, already in this manager's language.
    <p className="text-caption text-danger">{state.error}</p>
  );
}

export function CompanyForm({ name, locale }: { name: string; locale: Locale }) {
  const t = getCatalog(locale);
  const [state, action, pending] = useActionState<FormState, FormData>(updateCompanyName, null);
  return (
    <form action={action} className="space-y-3">
      <Field id="empresa-nome" label={t.profile.companyNameLabel}>
        {a11y => <Input {...a11y} name="nome" defaultValue={name} maxLength={120} required />}
      </Field>
      <div className="flex items-center gap-3">
        <Button type="submit" variant="secondary" size="sm" loading={pending}>
          {t.common.save}
        </Button>
        <Feedback state={state} t={t} />
      </div>
    </form>
  );
}

export function AccountForm({ fullName, phone, locale }: { fullName: string; phone: string; locale: Locale }) {
  const t = getCatalog(locale);
  const [state, action, pending] = useActionState<FormState, FormData>(updateProfile, null);
  return (
    <form action={action} className="space-y-3">
      <Field id="conta-nome" label={t.profile.fullNameLabel}>
        {a11y => <Input {...a11y} name="nome" defaultValue={fullName} maxLength={120} required />}
      </Field>
      {/* Pre-filled by splitting the stored E.164 number back into a flag and
          a national number, so an Argentine manager sees the number they know
          rather than the extra 9 WhatsApp needs. Saving puts the 9 back. */}
      <PhoneField
        id="conta-telemovel"
        name="telemovel"
        label={t.profile.phoneLabel}
        locale={locale}
        value={phone}
        required
        autoComplete="tel"
      />
      <div className="flex items-center gap-3">
        <Button type="submit" variant="secondary" size="sm" loading={pending}>
          {t.common.save}
        </Button>
        <Feedback state={state} t={t} />
      </div>
    </form>
  );
}
