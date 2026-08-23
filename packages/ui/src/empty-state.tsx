// An empty screen should say what to do next. Today "nothing here" is written
// ad hoc per screen, and usually says only that.
import type { ReactNode } from 'react';

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      {icon && <span className="text-fg-faint">{icon}</span>}
      <p className="text-heading text-fg">{title}</p>
      {body && <p className="max-w-sm text-callout text-fg-muted">{body}</p>}
      {action && <div className="pt-2">{action}</div>}
    </div>
  );
}
