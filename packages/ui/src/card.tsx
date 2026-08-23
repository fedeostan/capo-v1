// Level 1 of the three depth levels: a hairline border and NO shadow.
// Structure first; a shadow is for something that genuinely floats above
// something else (shadow-float on a sticky header, shadow-sheet on a sheet).
// Before this file the card was spelled five different ways.
import type { ReactNode } from 'react';

const PADDING = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
} as const;

export function Card({
  padding = 'md',
  as: Tag = 'div',
  children,
}: {
  padding?: keyof typeof PADDING;
  as?: 'div' | 'section' | 'article';
  children: ReactNode;
}) {
  return (
    <Tag className={`overflow-hidden rounded-card border border-hairline bg-surface ${PADDING[padding]}`}>
      {children}
    </Tag>
  );
}
