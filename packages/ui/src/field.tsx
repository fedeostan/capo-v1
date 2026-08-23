// Label, hint and error, ALWAYS connected. Today those 28 inputs and 22
// labels are wired by hand and inconsistently, which means some errors are
// never announced to a screen reader and some labels are not tappable.
//
// The render-prop shape is what makes the wiring impossible to forget: the
// control cannot be rendered without receiving the ids it must carry.
import type { ComponentProps, ReactNode } from 'react';

const CONTROL = [
  'w-full min-h-12 rounded-control px-3 py-2 text-body',
  'bg-surface-sunken text-fg',
  // border-control is 4.80:1. Its predecessor, zinc-500/30, was about 1.8:1
  // against WCAG 1.4.11's 3:1 floor — and that border is the ONLY signal that
  // a box is typeable, which is why the rule exists at all. This is visibly
  // more present than what it replaces, and deliberately so.
  'border border-control',
  'transition-[border-color,box-shadow] ease-out',
  'placeholder:text-fg-faint',
  'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
  'disabled:opacity-50',
  // 16px minimum on the control itself: iOS zooms the viewport when focusing
  // an input under 16px, and the app's viewport is locked, so the zoom never
  // comes back out.
  'aria-[invalid=true]:border-danger',
].join(' ');

export type FieldA11y = {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
  required?: boolean;
};

export function Field({
  id,
  label,
  hint,
  error,
  required = false,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: (a11y: FieldA11y) => ReactNode;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-callout font-medium text-fg">
        {label}
        {required && (
          <span aria-hidden className="text-danger">
            {' *'}
          </span>
        )}
      </label>
      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
        required,
      })}
      {hint && !error && (
        <p id={hintId} className="text-caption text-fg-muted">
          {hint}
        </p>
      )}
      {/* role=alert so a screen reader announces a validation failure the
          moment it appears, rather than only when focus happens to land. */}
      {error && (
        <p id={errorId} role="alert" className="text-caption text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function Input(props: Omit<ComponentProps<'input'>, 'className'>) {
  return <input {...props} className={CONTROL} />;
}

export function Textarea(props: Omit<ComponentProps<'textarea'>, 'className'>) {
  return <textarea {...props} className={`${CONTROL} min-h-24 resize-y`} />;
}

/** Native <select> on purpose: it works offline, matches the phone's own
 *  picker, and handles keyboards correctly. A custom one would be a modal,
 *  a focus trap and a scroll lock to maintain for no gain. */
export function Select(props: Omit<ComponentProps<'select'>, 'className'>) {
  return <select {...props} className={`${CONTROL} appearance-none pr-8`} />;
}