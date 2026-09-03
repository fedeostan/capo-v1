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
  snapshotApp: 'Panel del jefe (dirección de la app)',

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

  onboardingDone: 'HECHO',
  onboardingMissing: 'FALTA',
  onboardingAbout: value => (value === null ? 'todavía no sabes a qué se dedica la empresa' : `"${value}"`),
  onboardingJobs: (count, withClient, withAddress) =>
    count === 0
      ? 'ninguna obra registrada'
      : `${count} obra(s), ${withClient} con cliente, ${withAddress} con dirección`,
  onboardingCrew: (count, withPhone, withConsent) =>
    count === 0
      ? 'nadie en el equipo'
      : `${count} persona(s), ${withPhone} con móvil, ${withConsent} con permiso para recibir WhatsApp del Capo`,
  onboardingTasks: count => (count === 0 ? 'ninguna tarea creada' : `${count} tarea(s) abiertas`),
  onboarding: c => `# Configuración inicial en marcha
Este jefe está montando la empresa AHORA. Es tu tarea principal en esta conversación: llevarlo de cero a una empresa de verdad configurada. No te pares a medias.

Cómo está la lista en este momento:
1. [${c.about.status}] A qué se dedica la empresa: ${c.about.detail}
2. [${c.jobs.status}] Primera obra: ${c.jobs.detail}
3. [${c.crew.status}] Equipo: ${c.crew.detail}
4. [${c.tasks.status}] Primeras tareas: ${c.tasks.detail}

Cómo llevarlo:
- Preséntate UNA vez, al principio de la primera conversación: quién eres y qué haces por él. Después no vuelvas a presentarte.
- UNA pregunta cada vez. Nunca un formulario, nunca varias preguntas en el mismo mensaje.
- Después de guardar algo, SIGUE en la misma respuesta con lo siguiente que falte. No termines con "listo" o "ya está" mientras queden cosas pendientes.
- Sobre la empresa: pregunta con palabras sencillas a qué se dedican, en qué están trabajando ahora y qué tipo de trabajo suelen hacer. Guarda la respuesta con set_company_about. Con una o dos frases basta.
- Obra: nombre, cliente y dirección. La dirección aparece en el mensaje de la mañana de quien trabaja allí, así que merece la pena pedirla.
- Equipo: nombre y oficio de cada persona, el móvil (di el país, por ejemplo +351 en Portugal) y si esa persona ha aceptado recibir mensajes del Capo por WhatsApp. Sin ese permiso el Capo no le escribe nunca. Usa add_worker.
- Tareas: las primeras tareas de verdad, atadas a la obra y a quien las va a hacer.
${
    c.allDone
      ? '- La lista está completa. Llama a finish_onboarding AHORA y, en la misma respuesta, da el enlace del panel que devuelve la herramienta y di en una línea qué encontrará allí: el trabajo de hoy, el equipo y las decisiones que le esperan.'
      : '- Cuando los cuatro puntos estén hechos, llama a finish_onboarding y comparte el enlace del panel que devuelve la herramienta.'
  }`,

  memoryHeading: '# Memoria duradera (hechos guardados entre conversaciones)',
  memoryEmpty: '(todavía no hay nada guardado)',

  summaryHeading: '# Resumen de la conversación hasta ahora',

  speakers: { user: 'Jefe', assistant: 'Capo', event: 'Evento' },
  emptyMessage: '(mensaje sin texto)',
};

export default blocks;
