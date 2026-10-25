// The 16 sample tickets from reference/jirapowder-mockup.html, used in Demo mode only.
import type { IssueType, Priority, Snapshot, Sprint, StatusCat, Ticket } from './types';

const ME = 'Parth';
const SPRINTS: Record<string, Sprint> = {
  S42: { id: 42, name: 'PAY Sprint 42', state: 'closed' },
  S43: { id: 43, name: 'PAY Sprint 43', state: 'active' },
  S44: { id: 44, name: 'PAY Sprint 44', state: 'future' },
};
const EPIC = 'Payouts v2';
const TYPE_NAME: Record<string, string> = { story: 'Story', task: 'Task', bug: 'Bug' };
const STATUS_NAME: Record<StatusCat, string> = { todo: 'To Do', prog: 'In Progress', review: 'In Review', done: 'Done' };

type Row = { k: string; ty: IssueType; pr: Priority; t: string; s: StatusCat; a: string; sp: string; p: number; by: string[] };

const ROWS: Row[] = [
  { k: 'PAY-101', ty: 'task', pr: 'med', t: 'Define payout ledger schema', s: 'done', a: 'Maya Chen', sp: 'S42', p: 3, by: [] },
  { k: 'PAY-110', ty: 'task', pr: 'med', t: 'Auth scopes for payouts API', s: 'done', a: 'Dev Patel', sp: 'S42', p: 2, by: [] },
  { k: 'PAY-102', ty: 'task', pr: 'high', t: 'Migrate ledger tables to Postgres 16', s: 'prog', a: ME, sp: 'S43', p: 5, by: ['PAY-101'] },
  { k: 'PAY-111', ty: 'story', pr: 'med', t: 'Rate limiting on write endpoints', s: 'prog', a: 'Dev Patel', sp: 'S43', p: 3, by: ['PAY-110'] },
  { k: 'PAY-106', ty: 'story', pr: 'med', t: 'Retry and idempotency keys', s: 'review', a: 'Maya Chen', sp: 'S43', p: 3, by: ['PAY-101'] },
  { k: 'PAY-103', ty: 'story', pr: 'high', t: 'Ledger write API', s: 'todo', a: ME, sp: 'S43', p: 5, by: ['PAY-102', 'PAY-111'] },
  { k: 'PAY-115', ty: 'bug', pr: 'high', t: 'Fix currency rounding on JPY payouts', s: 'prog', a: ME, sp: 'S43', p: 1, by: [] },
  { k: 'PAY-104', ty: 'story', pr: 'high', t: 'Payout scheduler service', s: 'todo', a: 'Dev Patel', sp: 'S43', p: 8, by: ['PAY-103'] },
  { k: 'PAY-105', ty: 'story', pr: 'med', t: 'NACHA bank file export', s: 'todo', a: 'Sam Okafor', sp: 'S43', p: 5, by: ['PAY-103'] },
  { k: 'PAY-113', ty: 'task', pr: 'low', t: 'Payouts API reference docs', s: 'todo', a: 'Lena Ruiz', sp: 'S43', p: 2, by: ['PAY-103'] },
  { k: 'PAY-107', ty: 'story', pr: 'med', t: 'Payout status webhooks', s: 'todo', a: ME, sp: 'S43', p: 5, by: ['PAY-104', 'PAY-106'] },
  { k: 'PAY-109', ty: 'story', pr: 'med', t: 'Nightly reconciliation job', s: 'todo', a: 'Sam Okafor', sp: 'S43', p: 5, by: ['PAY-105', 'PAY-103'] },
  { k: 'PAY-108', ty: 'story', pr: 'med', t: 'Admin payouts dashboard', s: 'todo', a: 'Lena Ruiz', sp: 'S44', p: 8, by: ['PAY-107'] },
  { k: 'PAY-112', ty: 'task', pr: 'med', t: 'Load test payout flow', s: 'todo', a: ME, sp: 'S44', p: 3, by: ['PAY-104', 'PAY-109'] },
  { k: 'PAY-116', ty: 'task', pr: 'low', t: 'Regenerate SDK types', s: 'todo', a: 'Lena Ruiz', sp: 'S44', p: 1, by: ['PAY-113'] },
  { k: 'PAY-114', ty: 'task', pr: 'low', t: 'Feature-flag rollout plan', s: 'todo', a: 'Maya Chen', sp: 'S44', p: 2, by: ['PAY-112', 'PAY-108'] },
];

export function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

export function sampleTickets(): Ticket[] {
  const blocks: Record<string, string[]> = {};
  ROWS.forEach((r) => r.by.forEach((b) => (blocks[b] ??= []).push(r.k)));
  return ROWS.map((r) => ({
    key: r.k,
    summary: r.t,
    status: r.s,
    statusName: STATUS_NAME[r.s],
    type: r.ty,
    typeName: TYPE_NAME[r.ty] ?? 'Other',
    priority: r.pr,
    assignee: { name: r.a, initials: initialsOf(r.a) },
    isMine: r.a === ME,
    sprint: { ...SPRINTS[r.sp]! },
    points: r.p,
    epic: EPIC,
    blockedBy: [...r.by],
    blocks: blocks[r.k] ?? [],
    url: `https://example.atlassian.net/browse/${r.k}`,
    inScope: true,
  }));
}

export function sampleSnapshot(): Snapshot {
  return { fetchedAt: new Date().toISOString(), scopeLabel: 'Demo data', tickets: sampleTickets(), warnings: [] };
}

/** Ticket the mockup selects on first load. */
export const SAMPLE_INITIAL_SELECTION = 'PAY-103';

/** Dev-only: sample data with an extra A→B→A blocking cycle (open the app with ?demo=cycle). */
export function cycleSnapshot(): Snapshot {
  const snap = sampleSnapshot();
  const t = (k: string) => snap.tickets.find((x) => x.key === k)!;
  // PAY-104 already waits on PAY-103; make PAY-103 also wait on PAY-104.
  t('PAY-103').blockedBy.push('PAY-104');
  t('PAY-104').blocks.push('PAY-103');
  return snap;
}

/** Dev only (`?demo=big&n=400`): a large active sprint for checking the map at scale. Deterministic. */
export function bigSnapshot(n = 400): Snapshot {
  let x = 42;
  const rnd = () => (x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)]!;
  const people = [ME, 'Maya Chen', 'Dev Patel', 'Sam Okafor', 'Lena Ruiz', 'Ivo Novak', 'Ana Silva', 'Kai Mori'];
  const verbs = ['Add', 'Fix', 'Migrate', 'Refactor', 'Document', 'Test', 'Ship', 'Harden', 'Split', 'Cache'];
  const things = ['ledger writes', 'payout retries', 'bank export', 'auth scopes', 'webhooks', 'rate limits', 'admin dashboard', 'reconciliation', 'FX rounding', 'audit log'];
  const epics = ['Payouts v2', 'Ledger', 'Compliance', 'Platform'];
  const tickets: Ticket[] = [];
  for (let i = 0; i < n; i++) {
    const key = `PAY-${1000 + i}`;
    const by = new Set<string>();
    if (i > 5 && rnd() < 0.62) by.add(`PAY-${1000 + Math.floor(i * (0.55 + rnd() * 0.45))}`);
    if (i > 5 && rnd() < 0.18) by.add(`PAY-${1000 + Math.floor(rnd() * i)}`);
    by.delete(key);
    const r = rnd();
    const s: StatusCat = r < 0.18 ? 'done' : r < 0.36 ? 'prog' : r < 0.44 ? 'review' : 'todo';
    const a = rnd() < 0.1 ? null : pick(people);
    const ty = pick<IssueType>(['story', 'story', 'task', 'task', 'bug']);
    tickets.push({
      key,
      summary: `${pick(verbs)} ${pick(things)}`,
      status: s,
      statusName: STATUS_NAME[s],
      type: ty,
      typeName: TYPE_NAME[ty]!,
      priority: pick<Priority>(['high', 'med', 'med', 'low']),
      assignee: a ? { name: a, initials: initialsOf(a) } : null,
      isMine: a === ME,
      sprint: SPRINTS.S43!,
      points: pick([1, 2, 3, 5, 8, null]),
      epic: pick(epics),
      blockedBy: [...by],
      blocks: [],
      url: '',
      inScope: true,
    });
  }
  const byKey = new Map(tickets.map((t) => [t.key, t]));
  for (const t of tickets) for (const b of t.blockedBy) byKey.get(b)!.blocks.push(t.key);
  return { fetchedAt: new Date(0).toISOString(), scopeLabel: `Demo: ${n} tickets`, tickets, warnings: [] };
}
