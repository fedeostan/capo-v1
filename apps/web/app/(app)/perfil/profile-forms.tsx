'use client';

// The two editable cards on /perfil. useActionState rather than a redirect
// round-trip so a validation error lands next to the field that caused it and
// the typed value survives.
import { useActionState } from 'react';
import { updateCompanyName, updateProfile, type FormState } from './actions';

const FIELD =
  'w-full rounded-lg border border-zinc-500/30 bg-transparent px-3 py-2 text-sm outline-none focus:border-orange-600';
const SUBMIT =
  'rounded-lg bg-orange-600 px-3 py-2 text-sm font-semibold text-white active:bg-orange-700 disabled:opacity-50';

function Feedback({ state }: { state: FormState }) {
  if (!state) return null;
  return state.ok ? (
    <p className="text-xs text-emerald-600 dark:text-emerald-400">Guardado.</p>
  ) : (
    <p className="text-xs text-red-600">{state.error}</p>
  );
}

export function CompanyForm({ name }: { name: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(updateCompanyName, null);
  return (
    <form action={action} className="space-y-2">
      <label className="block space-y-1">
        <span className="text-xs text-zinc-500">Nome da empresa</span>
        <input name="nome" defaultValue={name} maxLength={120} required className={FIELD} />
      </label>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={SUBMIT}>
          Guardar
        </button>
        <Feedback state={state} />
      </div>
    </form>
  );
}

export function AccountForm({ fullName, phone }: { fullName: string; phone: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(updateProfile, null);
  return (
    <form action={action} className="space-y-2">
      <label className="block space-y-1">
        <span className="text-xs text-zinc-500">O teu nome</span>
        <input name="nome" defaultValue={fullName} maxLength={120} required className={FIELD} />
      </label>
      <label className="block space-y-1">
        <span className="text-xs text-zinc-500">Telemóvel</span>
        <input name="telemovel" type="tel" defaultValue={phone} required className={FIELD} />
      </label>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={SUBMIT}>
          Guardar
        </button>
        <Feedback state={state} />
      </div>
    </form>
  );
}
