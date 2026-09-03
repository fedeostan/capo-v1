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
Esta empresa todavía no tiene obras, equipo ni tareas registradas. Es la primera conversación. Preséntate una vez (quién eres, qué haces) y después guía al jefe en la configuración inicial, UNA pregunta cada vez, nunca un formulario completo:
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

  workerIdentityHeading: '# Con quién estás hablando',
  workerIdentityName: 'Nombre',
  workerIdentityTrade: 'Oficio',
  workerIdentityCompany: 'Empresa',
  workerIdentityManagers: 'Quién manda en la empresa',
  workerIdentityLanguage: 'Idioma en el que le escribes',
  workerIdentityNote:
    'Estos datos son sobre la persona con la que estás hablando. Si pregunta cómo se llama, en qué empresa trabaja, cuál es su oficio, quién es el jefe o en qué idioma estáis hablando, contesta en una línea con lo de aquí. No la mandes hablar con el encargado por esto.',
};

export default blocks;
