// Pure graph logic over Ticket[]. No DOM access.
import type { Snapshot, Ticket } from '../types';

export interface Graph {
  /** key → ticket */
  byKey: Map<string, Ticket>;
  /** key → keys it is blocked by (only keys present in the snapshot) */
  by: Map<string, string[]>;
  /** key → keys it blocks (only keys present in the snapshot) */
  rev: Map<string, string[]>;
}

export function buildGraph(tickets: Ticket[]): Graph {
  const byKey = new Map(tickets.map((t) => [t.key, t]));
  const by = new Map<string, string[]>();
  const rev = new Map<string, string[]>();
  for (const t of tickets) {
    by.set(t.key, []);
    rev.set(t.key, []);
  }
  const add = (blocker: string, blocked: string) => {
    if (blocker === blocked || !byKey.has(blocker) || !byKey.has(blocked)) return;
    const b = by.get(blocked)!;
    if (!b.includes(blocker)) b.push(blocker);
    const r = rev.get(blocker)!;
    if (!r.includes(blocked)) r.push(blocked);
  };
  // Links may be listed on either side; union both so the graph is symmetric.
  // blockedBy first so each ticket keeps its own blocker order.
  for (const t of tickets) t.blockedBy.forEach((b) => add(b, t.key));
  for (const t of tickets) t.blocks.forEach((d) => add(t.key, d));
  return { byKey, by, rev };
}

const isDone = (g: Graph, k: string) => g.byKey.get(k)?.status === 'done';

/** Open (not done) blockers of a ticket. */
export function openBlockers(g: Graph, k: string): string[] {
  return (g.by.get(k) ?? []).filter((b) => !isDone(g, b));
}

/** A ticket is ready when it is open and every blocker is done. */
export function isReady(g: Graph, k: string): boolean {
  return !isDone(g, k) && openBlockers(g, k).length === 0;
}

/** Iterative walk along `next`, optionally restricted to `within`. Cycle-safe. */
function walk(start: string, next: Map<string, string[]>, within?: Set<string>): Set<string> {
  const acc = new Set<string>();
  const stack = [...(next.get(start) ?? [])];
  while (stack.length) {
    const k = stack.pop()!;
    if (acc.has(k) || (within && !within.has(k))) continue;
    acc.add(k);
    stack.push(...(next.get(k) ?? []));
  }
  acc.delete(start);
  return acc;
}

/** Everything upstream (transitively blocking `k`). */
export const ancestors = (g: Graph, k: string, within?: Set<string>) => walk(k, g.by, within);
/** Everything downstream (transitively blocked by `k`). */
export const descendants = (g: Graph, k: string, within?: Set<string>) => walk(k, g.rev, within);

/** Open ancestors in dependency order (deepest blockers first) — "Path to start". */
export function pathToStart(g: Graph, k: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>([k]);
  const visit = (x: string) => {
    for (const b of g.by.get(x) ?? []) {
      if (seen.has(b)) continue;
      seen.add(b);
      visit(b);
      if (!isDone(g, b)) out.push(b);
    }
  };
  visit(k);
  return out;
}

export interface Waves {
  waves: string[][];
  /** Tickets caught in a blocking cycle, appended as a final wave. */
  cyclic: string[];
}

/** Work order: groups of open tickets where each group only waits on earlier groups. */
export function workOrder(g: Graph, visible: Iterable<string>): Waves {
  const left = new Set([...visible].filter((k) => g.byKey.has(k) && !isDone(g, k)));
  const waves: string[][] = [];
  while (left.size) {
    const wave = [...left].filter((k) => (g.by.get(k) ?? []).every((b) => !left.has(b)));
    if (!wave.length) break;
    wave.forEach((k) => left.delete(k));
    waves.push(wave);
  }
  return { waves, cyclic: [...left] };
}

export interface Filter {
  /** Sprint id as a string, or 'all'. */
  sprint: string;
  mine: boolean;
}

export interface Visible {
  /** Tickets matching the filter. */
  base: Set<string>;
  /** base plus their direct blockers and blocked tickets ("ghosts" when not in base). */
  vis: Set<string>;
}

export function computeVisible(g: Graph, tickets: Ticket[], f: Filter): Visible {
  let b = tickets.filter((t) => t.inScope && (f.sprint === 'all' || String(t.sprint?.id) === f.sprint));
  if (f.mine) b = b.filter((t) => t.isMine);
  const base = new Set(b.map((t) => t.key));
  const vis = new Set(base);
  for (const t of b) {
    (g.by.get(t.key) ?? []).forEach((x) => vis.add(x));
    (g.rev.get(t.key) ?? []).forEach((x) => vis.add(x));
  }
  return { base, vis };
}

export interface SprintOption {
  value: string;
  label: string;
  state: 'active' | 'future' | 'closed';
}

const STATE_WORD = { active: 'active', future: 'next', closed: 'closed' } as const;
const STATE_ORDER = { active: 0, future: 1, closed: 2 } as const;

/** Distinct sprints of in-scope tickets, active first, then future, then closed. */
export function sprintOptions(snapshot: Snapshot): SprintOption[] {
  const seen = new Map<number, SprintOption>();
  for (const t of snapshot.tickets) {
    if (!t.inScope || !t.sprint || seen.has(t.sprint.id)) continue;
    const s = t.sprint;
    seen.set(s.id, { value: String(s.id), label: `${s.name} (${STATE_WORD[s.state]})`, state: s.state });
  }
  return [...seen.values()].sort(
    (a, b) =>
      STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
      (a.state === 'closed' ? Number(b.value) - Number(a.value) : Number(a.value) - Number(b.value)),
  );
}

/** Default pick for the sprint picker: the active sprint, else the first option, else all. */
export function defaultSprint(opts: SprintOption[]): string {
  return (opts.find((o) => o.state === 'active') ?? opts[0])?.value ?? 'all';
}
