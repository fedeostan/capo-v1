import type { PromptBlocks } from './prompt-blocks';

const blocks: PromptBlocks = {
  knowledgeHeading: '# Knowledge base (via search_knowledge)',
  knowledgeIntro: 'Documents you can consult to ground legal or technical answers:',

  snapshotHeading: '# Company snapshot',
  snapshotCompany: 'Company',
  snapshotActiveJobs: 'Active jobs',
  snapshotActiveWorkers: 'Active workers',
  snapshotOpenTasks: 'Open tasks',
  snapshotPendingProposals: 'Pending proposals',

  firstUse: `# First use
This company has no jobs, crew, or tasks on record yet — this is the first conversation. Introduce yourself once (who you are, what you do), then walk the manager through the initial setup ONE question at a time, never a full form:
1. First job (name, address, client)
2. Crew (names, trades, mobile numbers in E.164 format)
3. First tasks
Mention, where it fits naturally, that results show up under the Today/Tomorrow/Jobs tabs.`,
  incompleteSetup: gaps => `# Incomplete setup
This company has some data on record, but ${gaps.join(' and ')}. If you have not already mentioned this in the conversation, raise the gap ONCE, naturally. If you already mentioned it (check the history), do not repeat yourself.`,
  gapNoJobs: 'there are still no jobs on record',
  gapNoWorkers: 'there are still no workers on record',

  memoryHeading: '# Durable memory (facts stored across conversations)',
  memoryEmpty: '(nothing stored yet)',

  summaryHeading: '# Summary of the conversation so far',

  speakers: { user: 'Manager', assistant: 'Capo', event: 'Event' },
  emptyMessage: '(message with no text)',
};

export default blocks;
