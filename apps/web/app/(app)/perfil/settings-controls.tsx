// The form controls the five settings rooms share, lifted out of the single
// perfil/page.tsx they used to live in. Nothing here changed on the way — this
// file is a relocation, so a reviewer can read the split as a move.
//
// THE RADIO INPUTS ARE LOAD-BEARING AND MUST NOT BECOME BUTTONS OR CLIENT
// STATE. Every form below is a plain <form action={serverAction}>, which means
// a cold PWA on a bad site connection can select and save before any
// JavaScript has run — the situation these screens are actually used in. That
// property is invisible to tsc, to lint, to design-check and to next build;
// the only thing that catches its loss is loading a room with JavaScript
// disabled and pressing Save.
import { getCatalog, type Catalog } from '@capo/i18n/catalog';
import { LOCALES, type Locale } from '@capo/i18n/locale';
import { CONFIRM_POSTURES, type ConfirmPosture } from '@capo/db/posture';
import { setConfirmPosture, setWhatsAppConsent } from './actions';

export function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 rounded-xl border border-hairline p-4">
      <h2 className="text-caption font-semibold uppercase tracking-wide text-fg-muted">{title}</h2>
      {children}
    </section>
  );
}

// The save/error flash. Read from the redirect param the server actions set,
// so it must live in whichever room hosts the form that redirects — a room
// with forms and no Flash saves correctly and says nothing, which reads as a
// failure.
export function Flash({ guardado, erro, t }: { guardado?: string; erro?: string; t: Catalog }) {
  return (
    <>
      {guardado && (
        <p className="rounded-lg bg-success-quiet px-3 py-2 text-center text-callout text-success">
          {guardado === 'reversao' ? t.settings.reverted : t.settings.saved}
        </p>
      )}
      {erro && (
        <p className="rounded-lg bg-danger-quiet px-3 py-2 text-center text-callout text-danger">
          {erro === 'reversao' ? t.settings.revertFailed : t.settings.failed}
        </p>
      )}
    </>
  );
}

// Plain radio pills: no client JS, same posture as sign-out. Three options is
// not worth a client component.
export function Pills({ current }: { current: Locale }) {
  return (
    <div className="flex gap-2">
      {LOCALES.map(option => (
        <label key={option} className="flex-1">
          <input
            type="radio"
            name="idioma"
            value={option}
            defaultChecked={option === current}
            className="peer sr-only"
          />
          <span className="block cursor-pointer rounded-lg border border-control py-2 text-center text-callout peer-checked:border-brand peer-checked:bg-brand-quiet peer-checked:font-semibold">
            {getCatalog(option).meta.languageName}
          </span>
        </label>
      ))}
    </div>
  );
}

export function SubmitButton({ label }: { label: string }) {
  return (
    <button
      type="submit"
      className="w-full rounded-lg border border-control py-2 text-callout font-semibold hover:bg-surface-hover"
    >
      {label}
    </button>
  );
}

export function LanguagePills({
  current,
  action,
  save,
}: {
  current: Locale;
  action: (formData: FormData) => Promise<void>;
  save: string;
}) {
  return (
    <form action={action} className="space-y-2">
      <Pills current={current} />
      <SubmitButton label={save} />
    </form>
  );
}

// Same shape again — two options, no client JS, works before hydration on a
// cold PWA. A radio pair rather than a checkbox on purpose: a checkbox that
// submits on change can be toggled by a mis-tap and would silently withdraw
// consent, whereas this needs an explicit choice AND an explicit save.
export function WhatsAppConsentPills({ consenting, t }: { consenting: boolean; t: Catalog }) {
  return (
    <form action={setWhatsAppConsent} className="space-y-2">
      <div className="flex gap-2">
        {([true, false] as const).map(option => (
          <label key={String(option)} className="flex-1">
            <input
              type="radio"
              name="consentimento"
              value={option ? '1' : '0'}
              defaultChecked={option === consenting}
              className="peer sr-only"
            />
            <span className="block cursor-pointer rounded-lg border border-control py-2 text-center text-callout peer-checked:border-brand peer-checked:bg-brand-quiet peer-checked:font-semibold">
              {option ? t.settings.whatsappConsentOption.yes : t.settings.whatsappConsentOption.no}
            </span>
          </label>
        ))}
      </div>
      <SubmitButton label={t.common.save} />
    </form>
  );
}

// The confirmation posture (0031, issue #57): does an instruction to Capo that
// CHANGES something act immediately, or show an approval card first?
//
// Two options with a line of explanation UNDER each, rather than the bare pills
// used for language and theme. Those three are all reversible in one tap and
// their names say what they do; this one is a genuine safety/speed trade-off,
// and a manager cannot pick between "Always ask" and "Go ahead" from the labels
// alone. The hint under each option is the control, not decoration.
export function ConfirmPosturePills({ current, t }: { current: ConfirmPosture; t: Catalog }) {
  return (
    <form action={setConfirmPosture} className="space-y-2">
      <div className="space-y-2">
        {/* Indexing the two catalog records with a ConfirmPosture is the same
            tripwire themeOption uses: widen the union in @capo/db/posture
            without widening the copy and tsc fails right here. */}
        {CONFIRM_POSTURES.map(option => (
          <label key={option} className="block">
            <input
              type="radio"
              name="confirmacao"
              value={option}
              defaultChecked={option === current}
              className="peer sr-only"
            />
            <span className="block cursor-pointer rounded-lg border border-control p-3 peer-checked:border-brand peer-checked:bg-brand-quiet">
              <span className="block text-callout font-semibold">{t.settings.confirmPostureOption[option]}</span>
              <span className="mt-1 block text-caption text-fg-muted">
                {t.settings.confirmPostureOptionHint[option]}
              </span>
            </span>
          </label>
        ))}
      </div>
      <SubmitButton label={t.common.save} />
    </form>
  );
}
