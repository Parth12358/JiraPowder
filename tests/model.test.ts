import { describe, expect, it } from 'vitest';
import {
  ancestors,
  buildGraph,
  computeVisible,
  descendants,
  isReady,
  openBlockers,
  pathToStart,
  sprintOptions,
  workOrder,
} from '../src/graph/model';
import { sampleSnapshot, sampleTickets } from '../src/sample';
import { tk } from './helpers';

const tickets = sampleTickets();
const g = buildGraph(tickets);

describe('sample graph', () => {
  it('converts every sample ticket and derives blocks as the reverse of blockedBy', () => {
    expect(tickets).toHaveLength(16);
    expect(tickets.find((t) => t.key === 'PAY-103')!.blocks.sort()).toEqual(['PAY-104', 'PAY-105', 'PAY-109', 'PAY-113']);
  });

  it('ancestors of PAY-103', () => {
    expect(ancestors(g, 'PAY-103')).toEqual(new Set(['PAY-102', 'PAY-111', 'PAY-101', 'PAY-110']));
  });

  it('descendants of PAY-113', () => {
    expect(descendants(g, 'PAY-113')).toEqual(new Set(['PAY-116']));
  });

  it('ancestors can be restricted to a visible set', () => {
    expect(ancestors(g, 'PAY-103', new Set(['PAY-102', 'PAY-111']))).toEqual(new Set(['PAY-102', 'PAY-111']));
  });

  it('isReady', () => {
    expect(isReady(g, 'PAY-102')).toBe(true);
    expect(isReady(g, 'PAY-103')).toBe(false);
    expect(openBlockers(g, 'PAY-103')).toHaveLength(2);
    expect(isReady(g, 'PAY-101')).toBe(false); // done tickets are not "ready"
  });

  it('path to start lists open ancestors, deepest first', () => {
    expect(pathToStart(g, 'PAY-107')).toEqual(['PAY-102', 'PAY-111', 'PAY-103', 'PAY-104', 'PAY-106']);
  });
});

describe('work order', () => {
  const all = new Set(tickets.map((t) => t.key));
  const { waves, cyclic } = workOrder(g, all);
  const open = tickets.filter((t) => t.status !== 'done').map((t) => t.key);

  it('contains every open ticket exactly once', () => {
    const flat = waves.flat();
    expect(cyclic).toEqual([]);
    expect(flat.sort()).toEqual([...open].sort());
    expect(new Set(flat).size).toBe(flat.length);
  });

  it('never places a ticket before its open blockers', () => {
    const waveOf = new Map<string, number>();
    waves.forEach((w, i) => w.forEach((k) => waveOf.set(k, i)));
    for (const k of open)
      for (const b of openBlockers(g, k)) expect(waveOf.get(b)!).toBeLessThan(waveOf.get(k)!);
  });

  it('puts cyclic tickets in a separate group instead of dropping them', () => {
    const cg = buildGraph([tk('A', ['B']), tk('B', ['A']), tk('C', ['A'])]);
    const r = workOrder(cg, ['A', 'B', 'C']);
    expect(r.waves).toEqual([]);
    expect(r.cyclic.sort()).toEqual(['A', 'B', 'C']);
  });
});

describe('visible set', () => {
  it('pulls in direct neighbours of the sprint as ghosts', () => {
    const v = computeVisible(g, tickets, { sprint: '44', mine: false });
    expect([...v.base].sort()).toEqual(['PAY-108', 'PAY-112', 'PAY-114', 'PAY-116']);
    expect(v.vis.has('PAY-107')).toBe(true); // blocker of PAY-108, in sprint 43
    expect(v.base.has('PAY-107')).toBe(false);
  });

  it('My tickets keeps only mine', () => {
    const v = computeVisible(g, tickets, { sprint: 'all', mine: true });
    expect([...v.base].every((k) => g.byKey.get(k)!.isMine)).toBe(true);
    expect(v.base.size).toBe(5);
  });

  it('out-of-scope tickets are never in base', () => {
    const ts = [tk('A'), { ...tk('B', ['A']), inScope: false }];
    const v = computeVisible(buildGraph(ts), ts, { sprint: 'all', mine: false });
    expect([...v.base]).toEqual(['A']);
    expect(v.vis.has('B')).toBe(true);
  });
});

describe('sprint picker', () => {
  it('lists distinct sprints active first, then next, then closed', () => {
    expect(sprintOptions(sampleSnapshot()).map((o) => o.label)).toEqual([
      'PAY Sprint 43 (active)',
      'PAY Sprint 44 (next)',
      'PAY Sprint 42 (closed)',
    ]);
  });
});

describe('graph building', () => {
  it('merges links listed on either side and drops unknown keys', () => {
    const a = { ...tk('A'), blocks: ['B', 'ZZZ-1'] };
    const b = tk('B', ['A']);
    const gg = buildGraph([a, b]);
    expect(gg.by.get('B')).toEqual(['A']);
    expect(gg.rev.get('A')).toEqual(['B']);
  });
});
