import { ObrasList, type DashboardObra } from '@capo/ui';

const obra = (o: Partial<DashboardObra> & { id: string; name: string }): DashboardObra => ({
  address: null, company_id: 'c1', concluidas: 0, pendentes: 0, status: 'active', ...o,
});

/** The Obras tab on a normal day. */
export function ActiveSites() {
  return (
    <ObrasList
      locale="pt-PT" empty="Ainda não há obras."
      obras={[
        obra({ id: 'j1', name: 'Casa de Paco', address: 'Rua das Flores 12, Porto', pendentes: 4, concluidas: 11 }),
        obra({ id: 'j2', name: 'Moradia Alves', address: 'Av. da Boavista 340', pendentes: 7, concluidas: 2 }),
        obra({ id: 'j3', name: 'Loja Rua Augusta', address: null, pendentes: 2, concluidas: 9 }),
      ]}
    />
  );
}

/**
 * A paused obra stays on the list (migration 0038): pausing is a booking
 * decision, not a deletion, and a site that vanished had no route back.
 */
export function WithAPausedSite() {
  return (
    <ObrasList
      locale="pt-PT" empty="Ainda não há obras."
      obras={[
        obra({ id: 'j1', name: 'Casa de Paco', address: 'Rua das Flores 12, Porto', pendentes: 4, concluidas: 11 }),
        obra({ id: 'j4', name: 'Quinta do Lago', address: 'Loulé', pendentes: 6, concluidas: 0, status: 'paused' }),
      ]}
    />
  );
}

/** Overdue counts per site — what turns a list into a priority order. */
export function WithOverdueCounts() {
  return (
    <ObrasList
      locale="pt-PT" empty="Ainda não há obras."
      overdueByObra={{ j2: 3, j3: 1 }}
      obras={[
        obra({ id: 'j1', name: 'Casa de Paco', address: 'Rua das Flores 12, Porto', pendentes: 4, concluidas: 11 }),
        obra({ id: 'j2', name: 'Moradia Alves', address: 'Av. da Boavista 340', pendentes: 7, concluidas: 2 }),
        obra({ id: 'j3', name: 'Loja Rua Augusta', address: 'Rua Augusta 55, Lisboa', pendentes: 2, concluidas: 9 }),
      ]}
    />
  );
}

/** No obras yet — the first thing a new manager sees. */
export function Empty() {
  return <ObrasList locale="pt-PT" empty="Ainda não há obras registadas." obras={[]} />;
}
