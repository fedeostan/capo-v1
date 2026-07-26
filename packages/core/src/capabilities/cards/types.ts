// The shape of a proposal-card dictionary.
//
// Functions rather than format strings with placeholders: Spanish and English
// need different word order from Portuguese ("Criar tarefa: «X» na obra Y" vs
// "Create task: 'X' on the Y job"), and a function signature lets TypeScript
// enforce that every locale accepts exactly the arguments render.ts passes.
//
// Date arguments arrive PRE-FORMATTED (via formatDate) so each template is pure
// string assembly and cannot forget to format.

export type TaskStatus = 'pending' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
export type JobStatus = 'active' | 'paused' | 'done';

export interface CardStrings {
  taskStatus: Record<TaskStatus, string>;
  jobStatus: Record<JobStatus, string>;

  /** Hand-rolled rather than Intl.DateTimeFormat: @capo/core must render the
   *  same bytes on every runtime regardless of its ICU build, because the
   *  result is persisted to proposals.rendered_text and compared on approval. */
  formatDate(iso: string): string;

  errors: {
    jobNotFound(id: string): string;
    workerNotFound(id: string): string;
    taskNotFound(id: string): string;
    emptyChange: string;
    emptyPlan: string;
    noTemplate(action: string): string;
  };

  createTask(p: {
    title: string;
    jobName?: string;
    workerName?: string;
    startDate?: string;
    dueDate?: string;
  }): string;
  updateTask(p: { title: string; changes: string[] }): string;
  taskChange: {
    title(v: string): string;
    status(v: string): string;
    assignee(v: string): string;
    startDate(v: string): string;
    dueDate(v: string): string;
    job(v: string): string;
    description: string;
  };

  createJob(p: { name: string; address?: string; clientName?: string; startsOn?: string }): string;
  updateJob(p: { name: string; changes: string[] }): string;
  jobChange: {
    name(v: string): string;
    address(v: string): string;
    client(v: string): string;
    status(v: string): string;
    startsOn(v: string): string;
    endsOn(v: string): string;
  };

  addWorker(p: { name: string; trade?: string; phone?: string }): string;
  updateWorker(p: { name: string; changes: string[] }): string;
  workerChange: {
    name(v: string): string;
    trade(v: string): string;
    phone(v: string): string;
  };

  plan: {
    header(p: { jobName: string; count: number; from: string; to: string }): string;
    row(p: {
      index: number;
      title: string;
      from: string;
      to: string;
      days: number;
      workerName?: string;
    }): string;
    dependsOn(indices: number[]): string;
    materials(list: string[]): string;
  };
}

// System-event strings written to the conversation when a proposal resolves.
// Model-visible (they land in the thread as `event` rows) and manager-visible,
// so they follow the user locale like the cards do.
export interface EventStrings {
  rejected(renderedText: string): string;
  failed(renderedText: string, reason: string): string;
  approved(renderedText: string): string;
  unknownAction(action: string): string;
  staleArgs: string;
}
