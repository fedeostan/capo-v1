import { MaterialsList, type MaterialsGroup } from '@capo/ui';

// The labels are injected rather than built inside the component: the package
// is presentational by contract and never imports the copy catalog itself.
const labels = {
  empty: 'Nada para comprar esta semana.',
  noJobLabel: 'Sem obra',
  forLabel: (tasks: string[]) => `para: ${tasks.join(', ')}`,
  countLabel: (n: number) => `${n} ${n === 1 ? 'material' : 'materiais'}`,
  emptyGroupLabel: 'Sem materiais registados.',
  seeJobLabel: 'Ver obra',
};

const group = (obraId: string | null, obraName: string, items: [string, string[]][], extraTasks: string[] = []): MaterialsGroup => {
  const tasks = [...new Set([...items.flatMap(([, t]) => t), ...extraTasks])]
    .map((title, i) => ({ id: `${obraId}-t${i}`, title, materials: [] as string[] }));
  return {
    obraId, obraName, tasks,
    items: items.map(([material, forTasks]) => ({
      material,
      forTasks: forTasks.map(title => tasks.find(t => t.title === title)!),
    })),
  };
};

/** Two sites, open by default — three groups or fewer fit on a phone screen. */
export function ThisWeek() {
  return (
    <MaterialsList {...labels}
      groups={[
        group('j1', 'Casa de Paco', [
          ['Tinta branca 15L', ['Pintar tecto do quarto']],
          ['Cola de azulejo', ['Assentar azulejos da casa de banho']],
          ['Rodapé 8cm', ['Montar rodapé']],
        ]),
        group('j2', 'Moradia Alves', [
          ['Betão pronto 0,5m³', ['Betonilha do piso térreo']],
          ['Rede electrossoldada', ['Betonilha do piso térreo']],
        ]),
      ]}
    />
  );
}

/**
 * Past three groups the list opens COLLAPSED — Federico's complaint verbatim
 * was that seven sites means "you need to scroll like crazy", so the headers
 * become the index of the page instead.
 */
export function ManySitesCollapse() {
  return (
    <MaterialsList {...labels}
      groups={[
        group('j1', 'Casa de Paco', [['Tinta branca 15L', ['Pintar tecto']]]),
        group('j2', 'Moradia Alves', [['Betão pronto 0,5m³', ['Betonilha']]]),
        group('j3', 'Loja Rua Augusta', [['Vidro temperado 6mm', ['Montar montra']]]),
        group('j4', 'Quinta do Lago', [['Argamassa 25kg', ['Rebocar muro']]]),
      ]}
    />
  );
}

/** A site with work booked but nothing recorded to buy — the add-here case. */
export function GroupWithNothingRecorded() {
  return (
    <MaterialsList {...labels}
      groups={[
        group('j1', 'Casa de Paco', [['Tinta branca 15L', ['Pintar tecto do quarto']]]),
        group('j2', 'Moradia Alves', [], ['Limpeza final', 'Vistoria']),
      ]}
    />
  );
}

/** Work with no obra attached still needs buying. */
export function WithoutAnObra() {
  return (
    <MaterialsList {...labels}
      groups={[group(null, 'Sem obra', [['Sacos de cimento', ['Reparar degrau']]])]}
    />
  );
}
