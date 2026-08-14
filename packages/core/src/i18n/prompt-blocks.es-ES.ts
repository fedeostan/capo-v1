import type { PromptBlocks } from './prompt-blocks';

const blocks: PromptBlocks = {
  knowledgeHeading: '# Base de conocimiento disponible (vía search_knowledge)',
  knowledgeIntro: 'Documentos que puedes consultar para fundamentar respuestas legales o técnicas:',

  snapshotHeading: '# Estado actual de la empresa',
  snapshotManager: 'Jefe con el que estás hablando',
  snapshotCompany: 'Empresa',
  snapshotActiveJobs: 'Obras activas',
  snapshotActiveWorkers: 'Trabajadores activos',
  snapshotOpenTasks: 'Tareas abiertas',
  snapshotPendingProposals: 'Propuestas pendientes',

  firstUse: `# Primer uso
Esta empresa todavía no tiene obras, equipo ni tareas registradas — es la primera conversación. Preséntate una vez (quién eres, qué haces) y después guía al jefe en la configuración inicial, UNA pregunta cada vez, nunca un formulario completo:
1. Primera obra (nombre, dirección, cliente)
2. Equipo (nombres, oficios, móviles en formato E.164)
3. Primeras tareas
Menciona, cuando venga a cuento, que los resultados aparecen en las pestañas Tareas/Obras.`,
  incompleteSetup: gaps => `# Configuración incompleta
Esta empresa ya tiene algo registrado, pero ${gaps.join(' y ')}. Si aún no lo has mencionado en esta conversación, señala la carencia UNA vez, de forma natural. Si ya la mencionaste antes (mira el historial), no repitas.`,
  gapNoJobs: 'todavía no hay obras registradas',
  gapNoWorkers: 'todavía no hay trabajadores registrados',

  memoryHeading: '# Memoria duradera (hechos guardados entre conversaciones)',
  memoryEmpty: '(todavía no hay nada guardado)',

  summaryHeading: '# Resumen de la conversación hasta ahora',

  speakers: { user: 'Jefe', assistant: 'Capo', event: 'Evento' },
  emptyMessage: '(mensaje sin texto)',
};

export default blocks;
