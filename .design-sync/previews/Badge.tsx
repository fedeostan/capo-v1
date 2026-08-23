import { Badge } from '@capo/ui';

/** A badge is read as a SHAPE, not a sentence — which is the one place 11px
 *  type is legitimate, and why it is uppercase and tracked. Everything a
 *  human actually reads is 13px or larger.
 *
 *  `review` is violet deliberately: a completion claim awaiting the manager
 *  is a decision to make, not a problem to fix. `danger` owns "wrong". */
export function Tones() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
      <Badge tone="neutral">neutral</Badge>
      <Badge tone="info">info</Badge>
      <Badge tone="warn">warn</Badge>
      <Badge tone="danger">danger</Badge>
      <Badge tone="success">success</Badge>
      <Badge tone="brand">brand</Badge>
      <Badge tone="review">review</Badge>
    </div>
  );
}

/** In the words the product actually uses on the board. */
export function AsUsed() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
      <Badge tone="warn">atrasada</Badge>
      <Badge tone="review">por rever</Badge>
      <Badge tone="success">concluída</Badge>
      <Badge tone="danger">em risco</Badge>
    </div>
  );
}

/** `strikethrough` for something cancelled — the tone still carries the
 *  category, the line carries the fact that it no longer applies. */
export function Strikethrough() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
      <Badge tone="neutral" strikethrough>cancelada</Badge>
      <Badge tone="danger" strikethrough>atrasada</Badge>
    </div>
  );
}
