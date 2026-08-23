// The button, in four levels. Before this file there were fifteen distinct
// hand-written class strings for the primary button alone, differing in
// padding, text size and which pseudo-states they bothered with.
//
// `className` is deliberately OMITTED from every props type. A component that
// accepts arbitrary classes is a component that will be overridden into a
// sixteenth variant within a month, and `tsc` refusing the prop is the only
// thing that reliably prevents it. If a caller genuinely needs something new,
// it belongs here as a variant.
//
// No 'use client': every state below — press, hover, focus, disabled — is
// pure CSS, so this renders on the server and ships no JavaScript.
import type { ComponentProps, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'tertiary' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg';

/**
 * THE RULE: at most one `primary` per screen.
 *
 * Not a style guide — the reason the hierarchy works at all. Three solid
 * orange buttons force the manager to read all three to find the one he wants.
 * One solid button means he does not read at all, he just taps. Everything
 * else on the screen being quiet is what buys that.
 */
const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-on-brand hover:bg-brand-hover',
  secondary: 'bg-surface text-fg border border-control hover:bg-surface-hover',
  tertiary: 'bg-transparent text-fg hover:bg-surface-hover',
  // Outlined at rest, on purpose. A solid red button is for the FINAL confirm
  // inside a sheet, never for the resting state of a screen — a destructive
  // action should not be the loudest thing a tired person sees.
  destructive: 'bg-surface text-danger border border-danger hover:bg-danger-quiet',
};

// 44px is the floor (Apple HIG / Material), 48px the primary-action size.
// A man in work gloves is the design target, not a mouse pointer.
const SIZE: Record<ButtonSize, string> = {
  sm: 'min-h-11 px-3 gap-2 text-callout',
  md: 'min-h-12 px-4 gap-2 text-body',
  lg: 'min-h-14 px-6 gap-2 text-body',
};

const BASE = [
  // `relative` is the spinner's positioning context — it is absolutely
  // positioned so the label can stay in the tree and hold the width.
  'relative inline-flex items-center justify-center rounded-control font-semibold',
  'select-none no-underline',
  // 120ms, fast start and gentle stop. `transition` alone would already be
  // 180ms from --default-transition-duration; the press wants to be quicker.
  'transition-[background-color,transform,box-shadow] duration-(--duration-fast) ease-out',
  'active:scale-[0.97]',
  // focus-visible, never focus: this must appear for keyboard users and never
  // flash on a touch tap. Before this component, one file in the entire app
  // had a focus style at all.
  'outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
  'disabled:pointer-events-none disabled:opacity-50',
].join(' ');

export function buttonClasses(
  variant: ButtonVariant = 'primary',
  size: ButtonSize = 'md',
  fullWidth = false,
): string {
  return `${BASE} ${VARIANT[variant]} ${SIZE[size]} ${fullWidth ? 'w-full' : ''}`;
}

/** A spinner that occupies the label's place without resizing the button. */
function Spinner() {
  return (
    <span
      aria-hidden
      className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
    />
  );
}

export type ButtonProps = Omit<ComponentProps<'button'>, 'className'> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
  icon?: ReactNode;
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  fullWidth = false,
  icon,
  children,
  disabled,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClasses(variant, size, fullWidth)}
    >
      {/* The label stays in the tree while loading, hidden and zero-opacity,
          so the button keeps its exact rendered width. Swapping the label out
          for a spinner makes the button shrink and the layout jump under the
          thumb that just tapped it — on a form where Guardar is the last
          control, that moves the page while the manager is still looking. */}
      <span className={`inline-flex items-center gap-2 ${loading ? 'invisible' : ''}`}>
        {icon}
        {children}
      </span>
      {loading && (
        <span className="absolute inset-0 flex items-center justify-center">
          <Spinner />
        </span>
      )}
    </button>
  );
}

export type ButtonLinkProps = Omit<ComponentProps<'a'>, 'className'> & {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  icon?: ReactNode;
};

/** The same surface over an anchor. Deliberately a plain <a> rather than
 *  next/link: @capo/ui is shared with apps/operator and must not depend on a
 *  router. Callers inside apps/web wrap it or pass a next/link `href` — a
 *  same-origin href in this app is handled by the App Router regardless. */
export function ButtonLink({
  variant = 'secondary',
  size = 'md',
  fullWidth = false,
  icon,
  children,
  ...rest
}: ButtonLinkProps) {
  return (
    <a {...rest} className={buttonClasses(variant, size, fullWidth)}>
      {icon}
      {children}
    </a>
  );
}

export type IconButtonProps = Omit<ComponentProps<'button'>, 'className' | 'children'> & {
  /** Spoken by a screen reader. REQUIRED, and that is a design decision
   *  enforced by the compiler: an unlabelled icon button is invisible to a
   *  blind user, and making the label a required prop turns a code review
   *  somebody has to remember into a build failure they cannot miss. */
  label: string;
  icon: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
};

export function IconButton({ label, icon, variant = 'tertiary', size = 'md', ...rest }: IconButtonProps) {
  const square = size === 'sm' ? 'h-11 w-11' : size === 'lg' ? 'h-14 w-14' : 'h-12 w-12';
  return (
    <button
      {...rest}
      aria-label={label}
      title={label}
      className={`${BASE} ${VARIANT[variant]} ${square} shrink-0 p-0`}
    >
      {icon}
    </button>
  );
}

