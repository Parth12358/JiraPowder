import { describe, expect, it } from 'vitest';
import { buildGraph, readiness } from '../src/graph/model';
import { COLW, EXACT_MAX, countCrossings, flowDepths, forceLayout, layoutFlow, layoutGraph } from '../src/graph/layout';
import { PRESETS, loadColors } from '../src/ui/colors';
import { sampleTickets } from '../src/sample';
import { tk } from './helpers';

/** Deterministic pseudo-random sprint: `n` tickets, ~60% blocked by an earlier one, some by two. */
function sprint(n: number, seed = 7) {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const ts = Array.from({ length: n }, (_, i) => {
    const bb = new Set<string>();
    if (i > 3 && rnd() < 0.6) bb.add('P-' + Math.floor(rnd() * i));
    if (i > 3 && rnd() < 0.15) bb.add('P-' + Math.floor(rnd() * i));
    return tk('P-' + i, [...bb]);
  });
  return ts;
}

/** The mockup's single forward pass, for comparison. */
function firstPassCrossings(n: number) {
  const ts = sprint(n);
  const g = buildGraph(ts);
  const vis = new Set(ts.map((t) => t.key));
  const { depth } = flowDepths(g, vis);
  const cols: string[][] = [];
  vis.forEach((k) => (cols[depth[k]!] ??= []).push(k));
  const idx: Record<string, number> = {};
  const y: Record<string, number> = {};
  cols.forEach((c, d) => {
    if (d === 0) c.sort((a, b) => a.localeCompare(b));
    else {
      const avg = (k: string) => {
        const bs = g.by.get(k)!.filter((b) => y[b] != null);
        return bs.length ? bs.reduce((s, b) => s + y[b]!, 0) / bs.length : 0;
      };
      c.sort((a, b) => avg(a) - avg(b));
    }
    c.forEach((k, i) => ((idx[k] = i), (y[k] = i - (c.length - 1) / 2)));
  });
  const edges: [string, string][] = [];
  vis.forEach((k) => g.by.get(k)!.forEach((b) => edges.push([b, k])));
  return { edges, depth, before: countCrossings(edges, depth, idx) };
}

describe('flow layout at scale', () => {
  it('has fewer arrow crossings than the single forward pass', () => {
    for (const n of [60, 200, 400]) {
      const { edges, depth, before } = firstPassCrossings(n);
      const ts = sprint(n);
      const { pos } = layoutFlow(buildGraph(ts), new Set(ts.map((t) => t.key)));
      // Row order within each depth column, read back from the positions.
      const idx: Record<string, number> = {};
      const byD: Record<number, string[]> = {};
      Object.keys(pos).forEach((k) => (byD[depth[k]!] ??= []).push(k));
      Object.values(byD).forEach((c) =>
        c.sort((a, b) => pos[a]!.y - pos[b]!.y || pos[a]!.x - pos[b]!.x).forEach((k, i) => (idx[k] = i)),
      );
      expect(countCrossings(edges, depth, idx)).toBeLessThanOrEqual(before);
    }
  });

  it('splits a tall column into sub-columns and keeps arrows pointing right', () => {
    const ts = [tk('ROOT'), ...Array.from({ length: 200 }, (_, i) => tk('C-' + i, ['ROOT']))];
    const g = buildGraph(ts);
    const vis = new Set(ts.map((t) => t.key));
    const { pos } = layoutFlow(g, vis);
    const xs = new Set(ts.slice(1).map((t) => pos[t.key]!.x));
    const ys = ts.slice(1).map((t) => pos[t.key]!.y);
    expect(xs.size).toBeGreaterThan(1);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(40 * 140);
    for (const t of ts.slice(1)) expect(pos[t.key]!.x).toBeGreaterThan(pos.ROOT!.x);
    // No two cards share a spot.
    expect(new Set(Object.values(pos).map((p) => `${p.x},${p.y}`)).size).toBe(ts.length);
  });

  it('leaves the sample sprint in plain columns (as in the mockup)', () => {
    const ts = sampleTickets();
    const { pos } = layoutFlow(buildGraph(ts), new Set(ts.map((t) => t.key)));
    for (const p of Object.values(pos)) expect(p.x % COLW).toBe(0);
  });
});

describe('graph layout at scale', () => {
  it('uses the quadtree above EXACT_MAX and gives finite, spread-out positions fast', () => {
    const n = 400;
    expect(n).toBeGreaterThan(EXACT_MAX);
    const ts = sprint(n);
    const g = buildGraph(ts);
    const t0 = performance.now();
    const pos = layoutGraph(g, new Set(ts.map((t) => t.key)), () => 0.5);
    const ms = performance.now() - t0;
    const ps = Object.values(pos);
    expect(ps.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true);
    // Nearest-neighbour distance: nobody sits on top of anybody.
    let close = 0;
    for (let i = 0; i < ps.length; i++) {
      let best = Infinity;
      for (let j = 0; j < ps.length; j++) if (i !== j) best = Math.min(best, Math.hypot(ps[i]!.x - ps[j]!.x, ps[i]!.y - ps[j]!.y));
      if (best < 20) close++;
    }
    expect(close).toBeLessThan(n * 0.02);
    expect(ms).toBeLessThan(1500); // the exact version took ~1.1 s here; generous for slow CI
  });

  it('agrees with the exact version on spread for a mid-size map', () => {
    const ts = sprint(EXACT_MAX + 1);
    const keys = ts.map((t) => t.key);
    const edges: [string, string][] = [];
    ts.forEach((t) => t.blockedBy.forEach((b) => edges.push([b, t.key])));
    const spread = (P: Record<string, { x: number; y: number }>) => {
      const v = Object.values(P);
      return Math.sqrt(v.reduce((s, p) => s + p.x * p.x + p.y * p.y, 0) / v.length);
    };
    const bh = spread(forceLayout(keys, edges, () => 0.5));
    const exact = spread(forceLayout(keys.slice(0, EXACT_MAX), edges.filter(([a, b]) => keys.indexOf(a) < EXACT_MAX && keys.indexOf(b) < EXACT_MAX), () => 0.5));
    expect(bh / exact).toBeGreaterThan(0.8);
    expect(bh / exact).toBeLessThan(1.3);
  });
});

describe('colour scheme', () => {
  it('readiness: done, then blocked, then in progress, then ready', () => {
    const g = buildGraph([tk('A'), tk('B', ['A']), tk('C', [], 'prog'), tk('D', ['A'], 'prog'), tk('E', [], 'done'), tk('F', ['E'])]);
    expect(['A', 'B', 'C', 'D', 'E', 'F'].map((k) => readiness(g, k))).toEqual(['ready', 'blocked', 'prog', 'blocked', 'done', 'ready']);
  });

  it('loads saved colours, ignoring junk, and falls back to mono', () => {
    const store: Record<string, string> = {};
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => (store[k] = v),
    };
    expect(loadColors()).toEqual(PRESETS.mono);
    store['jirapowder.colors'] = JSON.stringify({ 'own-mine': '#FF0000', 'st-ready': 'red', 'st-done': '#12345' });
    const c = loadColors();
    expect(c['own-mine']).toBe('#ff0000');
    expect(c['st-ready']).toBe(PRESETS.mono['st-ready']);
    expect(c['st-done']).toBe(PRESETS.mono['st-done']);
    store['jirapowder.colors'] = '{not json';
    expect(loadColors()).toEqual(PRESETS.mono);
    delete (globalThis as { localStorage?: unknown }).localStorage;
  });
});
