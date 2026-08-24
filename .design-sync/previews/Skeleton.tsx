import { Skeleton, Card } from '@capo/ui';

/** Shaped like the content that is coming, not a generic grey bar: a skeleton
 *  matching the eventual layout is what stops the page jumping when the data
 *  lands, which is the whole reason to show one. */
export function Shapes() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: 380 }}>
      <Skeleton variant="title" />
      <Skeleton variant="text" count={3} />
      <Skeleton variant="row" count={2} />
      <Skeleton variant="card" />
    </div>
  );
}

/** A loading card, as a screen actually shows it: a title placeholder over a
 *  few lines of body. */
export function LoadingCard() {
  return (
    <div style={{ maxWidth: 380 }}>
      <Card>
        <Skeleton variant="title" />
        <div style={{ paddingTop: '0.5rem' }}>
          <Skeleton variant="text" count={3} />
        </div>
      </Card>
    </div>
  );
}

/** A loading list — four rows shaped like the ListRows that will replace them. */
export function LoadingList() {
  return (
    <div style={{ maxWidth: 380 }}>
      <Skeleton variant="row" count={4} />
    </div>
  );
}
