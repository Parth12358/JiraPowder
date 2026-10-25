// Flow (columns) and Graph (force) layouts. Pure functions, no DOM access.
import type { Graph } from './model';
import { descendants } from './model';

export interface Point {
  x: number;
  y: number;
}
export type Positions = Record<string, Point>;

export const CW = 260;
export const CH = 118;
export const COLW = 340;
export const ROWH = 140;

export interface LayoutResult {
  pos: Positions;
  warnings: string[];
}

/**
 * Column per dependency depth. Depth is computed with an explicit on-stack set:
 * an edge back into a ticket still being resolved (a cycle) counts as depth 0
 * and adds a warning instead of recursing forever.
 */
export function flowDepths(g: Graph, vis: Set<string>): { depth: Record<string, number>; cycles: Set<string> } {
  const depth: Record<string, number> = {};
  const onStack = new Set<string>();
  const cycles = new Set<string>();
  const f = (k: string): number => {
    if (depth[k] != null) return depth[k];
    if (onStack.has(k)) {
      cycles.add(k);
      return -1; // back-edge: contributes 1 + (-1) = depth 0
    }
    onStack.add(k);
    const bs = (g.by.get(k) ?? []).filter((b) => vis.has(b));
    let d = 0;
    for (const b of bs) d = Math.max(d, 1 + f(b));
    onStack.delete(k);
    return (depth[k] = d);
  };
  vis.forEach((k) => f(k));
  return { depth, cycles };
}

export function layoutFlow(g: Graph, vis: Set<string>): LayoutResult {
  const { depth, cycles } = flowDepths(g, vis);
  const cols: Record<number, string[]> = {};
  vis.forEach((k) => (cols[depth[k]!] ??= []).push(k));
  const out: Positions = {};
  const avgY = (k: string) => {
    const bs = (g.by.get(k) ?? []).filter((x) => out[x]);
    return bs.length ? bs.reduce((s, x) => s + out[x]!.y, 0) / bs.length : 0;
  };
  Object.keys(cols)
    .map(Number)
    .sort((a, b) => a - b)
    .forEach((d) => {
      const c = cols[d]!;
      if (d === 0) c.sort((a, b) => a.localeCompare(b));
      else c.sort((a, b) => avgY(a) - avgY(b));
      c.forEach((k, i) => (out[k] = { x: d * COLW, y: (i - (c.length - 1) / 2) * ROWH }));
    });
  const warnings = cycles.size
    ? [`Blocking cycle between ${[...cycles].sort().join(', ')}. Some arrows point backwards.`]
    : [];
  return { pos: out, warnings };
}

export function layoutGraph(g: Graph, vis: Set<string>, rand: () => number = Math.random): Positions {
  const ks = [...vis];
  const P: Record<string, { x: number; y: number; vx: number; vy: number }> = {};
  ks.forEach((k, i) => {
    const a = (i / ks.length) * Math.PI * 2;
    P[k] = { x: Math.cos(a) * 220 + (rand() - 0.5) * 20, y: Math.sin(a) * 220 + (rand() - 0.5) * 20, vx: 0, vy: 0 };
  });
  const E: [string, string][] = [];
  ks.forEach((k) => (g.by.get(k) ?? []).forEach((b) => vis.has(b) && E.push([b, k])));
  for (let it = 0; it < 500; it++) {
    const cool = 1 - it / 500;
    for (let i = 0; i < ks.length; i++)
      for (let j = i + 1; j < ks.length; j++) {
        const a = P[ks[i]!]!,
          b = P[ks[j]!]!;
        const dx = a.x - b.x,
          dy = a.y - b.y,
          d2 = dx * dx + dy * dy + 0.01,
          d = Math.sqrt(d2);
        const f = 14000 / d2;
        a.vx += (dx / d) * f;
        a.vy += (dy / d) * f;
        b.vx -= (dx / d) * f;
        b.vy -= (dy / d) * f;
      }
    E.forEach(([s, t]) => {
      const a = P[s]!,
        b = P[t]!;
      const dx = b.x - a.x,
        dy = b.y - a.y,
        d = Math.hypot(dx, dy) || 1;
      const f = (d - 130) * 0.06;
      a.vx += (dx / d) * f;
      a.vy += (dy / d) * f;
      b.vx -= (dx / d) * f;
      b.vy -= (dy / d) * f;
    });
    ks.forEach((k) => {
      const p = P[k]!;
      p.vx -= p.x * 0.012;
      p.vy -= p.y * 0.012;
      p.vx *= 0.6;
      p.vy *= 0.6;
      const m = Math.hypot(p.vx, p.vy),
        cap = 30 * cool + 2;
      if (m > cap) {
        p.vx *= cap / m;
        p.vy *= cap / m;
      }
      p.x += p.vx;
      p.y += p.vy;
    });
  }
  const out: Positions = {};
  ks.forEach((k) => (out[k] = { x: P[k]!.x, y: P[k]!.y }));
  return out;
}

/** Graph-mode node radius grows with how much downstream work depends on the ticket. */
export function radius(g: Graph, k: string): number {
  return 11 + Math.min(descendants(g, k).size, 7) * 2.2;
}
