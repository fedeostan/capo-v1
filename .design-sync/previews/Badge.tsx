import { Badge } from '@capo/ui';

/** The default reading, `shape`: 11px, uppercase, tracked. That is the one
 *  place 11px type is legitimate, and it is legitimate because a short badge
 *  is RECOGNISED rather than read. Everything a human actually reads is 13px
 *  or larger — including a badge whose content is a phrase, which is what
 *  `reading="sentence"` below is for.
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

/** In the words the product actually uses on the board — and therefore in
 *  the SENTENCE reading, because that is what the board renders. Every task
 *  status Capo has is a phrase rather than a shape. */
export function AsUsed() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
      <Badge tone="neutral" reading="sentence">Pendente</Badge>
      <Badge tone="brand" reading="sentence">Em curso</Badge>
      <Badge tone="review" reading="sentence">A aguardar controlo</Badge>
      <Badge tone="success" reading="sentence">Concluída</Badge>
    </div>
  );
}

/** The two readings on the SAME label, because the difference between them is
 *  width and there is no other way to see it. Measured at 155px as a shape
 *  and 140px as a sentence — and on the board that difference is paid for by
 *  truncating the task title, which is the line the manager actually reads. */
export function Readings() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '0.5rem' }}>
      <Badge tone="review">A aguardar controlo</Badge>
      <Badge tone="review" reading="sentence">A aguardar controlo</Badge>
    </div>
  );
}

/** `strikethrough` for something cancelled — the tone still carries the
 *  category, the line carries the fact that it no longer applies. */
export function Strikethrough() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
      <Badge tone="neutral" reading="sentence" strikethrough>Cancelada</Badge>
      <Badge tone="danger" strikethrough>atrasada</Badge>
    </div>
  );
}
