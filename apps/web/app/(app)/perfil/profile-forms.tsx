'use client';

// The two editable cards on /perfil. useActionState rather than a redirect
// round-trip so a validation error lands next to the field that caused it and
// the typed value survives.
import { useActionState } from 'react';
import { getCatalog, type Catalog } from '@capo/i18n/catalog';
import type { Locale } from '@capo/i18n/locale';
import { updateCompanyName, updateProfile, type FormState } from './actions';

const FIELD =
  'w-full rounded-lg border border-zinc-500/30 bg-transparent px-3 py-2 text-sm outline-none focus:border-orange-600';
const SUBMIT =
  'rounded-lg bg-orange-600 px-3 py-2 text-sm font-semibold text-white active:bg-orange-700 disabled:opacity-50';

function Feedback({ state, t }: { state: FormState; t: Catalog }) {
  if (!state) return null;
  return state.ok ? (
    <p className="text-xs text-emerald-600 dark:text-emerald-400">{t.settings.saved}</p>
  ) : (
    // The error text is produced server-side, already in this manager's language.
    <p className="text-xs text-red-600">{state.error}</p>
  );
}

export function CompanyForm({ name, locale }: { name: string; locale: Locale }) {
  const t = getCatalog(locale);
  const [state, action, pending] = useActionState<FormState, FormData>(updateCompanyName, null);
  return (
    <form action={action} className="space-y-2">
      <label className="block space-y-1">
        <span className="text-xs text-zinc-500">{t.profile.companyNameLabel}</span>
        <input name="nome" defaultValue={name} maxLength={120} required className={FIELD} />
      </label>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={SUBMIT}>
          {t.common.save}
        </button>
        <Feedback state={state} t={t} />
      </div>
    </form>
  );
}

export function AccountForm({ fullName, phone, locale }: { fullName: string; phone: string; locale: Locale }) {
  const t = getCatalog(locale);
  const [state, action, pending] = useActionState<FormState, FormData>(updateProfile, null);
  return (
    <form action={action} className="space-y-2">
      <label className="block space-y-1">
        <span className="text-xs text-zinc-500">{t.profile.fullNameLabel}</span>
        <input name="nome" defaultValue={fullName} maxLength={120} required className={FIELD} />
      </label>
      <label className="block space-y-1">
        <span className="text-xs text-zinc-500">{t.profile.phoneLabel}</span>
        <input name="telemovel" type="tel" defaultValue={phone} required className={FIELD} />
      </label>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={SUBMIT}>
          {t.common.save}
        </button>
        <Feedback state={state} t={t} />
      </div>
    </form>
  );
}
