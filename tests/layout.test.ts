import { describe, expect, it } from 'vitest';
import { buildGraph } from '../src/graph/model';
import { COLW, flowDepths, layoutFlow, layoutGraph, radius } from '../src/graph/layout';
import { sampleTickets } from '../src/sample';
import { tk } from './helpers';

describe('flow layout', () => {
  const ts = sampleTickets();
  const g = buildGraph(ts);
  const vis = new Set(ts.map((t) => t.key));

  it('every edge goes from a lower column to a higher column', () => {
    const { pos, warnings } = layoutFlow(g, vis);
    expect(warnings).toEqual([]);
    for (const k of vis) for (const b of g.by.get(k)!) expect(pos[b]!.x).toBeLessThan(pos[k]!.x);
  });

  it('places roots in column 0', () => {
    const { pos } = layoutFlow(g, vis);
    expect(pos['PAY-101']!.x).toBe(0);
    expect(pos['PAY-103']!.x).toBe(2 * COLW);
  });
});

describe('cycle safety', () => {
  const cyc = buildGraph([tk('A', ['B']), tk('B', ['A'])]);
  const vis = new Set(['A', 'B']);

  it('flow depth treats the back-edge as depth 0 and warns', () => {
    const { depth, cycles } = flowDepths(cyc, vis);
    expect(Object.keys(depth).sort()).toEqual(['A', 'B']);
    expect(Math.min(depth.A!, depth.B!)).toBe(0);
    expect(cycles.size).toBeGreaterThan(0);
    const r = layoutFlow(cyc, vis);
    expect(r.warnings[0]).toMatch(/cycle/i);
    expect(Object.keys(r.pos)).toHaveLength(2);
  });

  it('graph layout and radius terminate on a cycle', () => {
    const p = layoutGraph(cyc, vis, () => 0.5);
    expect(Number.isFinite(p.A!.x) && Number.isFinite(p.B!.y)).toBe(true);
    expect(radius(cyc, 'A')).toBeGreaterThan(11);
  });

  it('a long chain does not overflow the stack', () => {
    const N = 5000;
    const chain = Array.from({ length: N }, (_, i) => tk('K-' + i, i ? ['K-' + (i - 1)] : []));
    const cg = buildGraph(chain);
    const v = new Set(chain.map((t) => t.key));
    expect(() => layoutFlow(cg, v)).not.toThrow();
  });
});
