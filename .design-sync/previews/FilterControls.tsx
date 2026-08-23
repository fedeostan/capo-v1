import { FilterControls } from '@capo/ui';

const obras = [
  { id: 'j1', name: 'Casa de Paco', status: 'active' },
  { id: 'j2', name: 'Moradia Alves', status: 'active' },
  { id: 'j3', name: 'Loja Rua Augusta', status: 'active' },
  { id: 'j4', name: 'Quinta do Lago', status: 'paused' },
];

/** Unfiltered: every obra, no day chosen. */
export function NoFilter() {
  return (
    <div style={{ maxWidth: 460, padding: '0.75rem' }}>
      <FilterControls locale="pt-PT" obras={obras}
        filters={{ quando: { kind: 'keyword', value: 'todas' }, obraId: null }} />
    </div>
  );
}

/** Narrowed to one building site. */
export function ScopedToOneObra() {
  return (
    <div style={{ maxWidth: 460, padding: '0.75rem' }}>
      <FilterControls locale="pt-PT" obras={obras}
        filters={{ quando: { kind: 'keyword', value: 'todas' }, obraId: 'j2' }} />
    </div>
  );
}

/** A specific day picked rather than a keyword. */
export function ASpecificDay() {
  return (
    <div style={{ maxWidth: 460, padding: '0.75rem' }}>
      <FilterControls locale="pt-PT" obras={obras}
        filters={{ quando: { kind: 'date', iso: '2026-08-26' }, obraId: 'j1' }} />
    </div>
  );
}
