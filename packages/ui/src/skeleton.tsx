// Shaped like the content that is coming, not a generic grey bar: a skeleton
// that matches the eventual layout stops the page from jumping when the data
// lands, which is the whole reason to show one.
const SHAPE = {
  text: 'h-4 w-full rounded-chip',
  title: 'h-6 w-1/2 rounded-chip',
  row: 'h-14 w-full rounded-card',
  card: 'h-28 w-full rounded-card',
} as const;

export function Skeleton({
  variant = 'text',
  count = 1,
}: {
  variant?: keyof typeof SHAPE;
  count?: number;
}) {
  return (
    <div className="flex flex-col gap-2" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} className={`block animate-pulse bg-surface-hover ${SHAPE[variant]}`} />
      ))}
    </div>
  );
}
