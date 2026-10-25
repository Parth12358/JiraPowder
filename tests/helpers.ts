import type { Ticket } from '../src/types';

/** Minimal ticket for hand-built graphs. */
export function tk(key: string, blockedBy: string[] = [], status: Ticket['status'] = 'todo'): Ticket {
  return {
    key,
    summary: key,
    status,
    statusName: status,
    type: 'task',
    typeName: 'Task',
    priority: 'med',
    assignee: null,
    isMine: false,
    sprint: { id: 1, name: 'S1', state: 'active' },
    points: null,
    epic: null,
    blockedBy,
    blocks: [],
    url: '',
    inScope: true,
  };
}
