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

/** Gap between the sub-columns of one wide depth column (tighter than between depths). */
export const SUBW = CW + 40;

/** Crossings between edges whose ends sit in the same pair of columns. */
export function countCrossings(edges: [string, string][], depth: Record<string, number>, idx: Record<string, number>): number {
  const groups = new Map<string, [string, string][]>();
  for (const e of edges) {
    const key = depth[e[0]] + ':' + depth[e[1]];
    let grp = groups.get(key);
    if (!grp) groups.set(key, (grp = []));
    grp.push(e);
  }
  let n = 0;
  for (const grp of groups.values())
    for (let i = 0; i < grp.length; i++)
      for (let j = i + 1; j < grp.length; j++) {
        const [a, b] = grp[i]!,
          [c, d] = grp[j]!;
        if ((idx[a]! - idx[c]!) * (idx[b]! - idx[d]!) < 0) n++;
      }
  return n;
}

export function layoutFlow(g: Graph, vis: Set<string>): LayoutResult {
  const { depth, cycles } = flowDepths(g, vis);
  const byDepth: Record<number, string[]> = {};
  vis.forEach((k) => (byDepth[depth[k]!] ??= []).push(k));
  const cols = Object.keys(byDepth)
    .map(Number)
    .sort((a, b) => a - b)
    .map((d) => byDepth[d]!);
  const preds = (k: string) => (g.by.get(k) ?? []).filter((x) => vis.has(x));
  const succs = (k: string) => (g.rev.get(k) ?? []).filter((x) => vis.has(x));
  const edges: [string, string][] = [];
  vis.forEach((k) => preds(k).forEach((b) => edges.push([b, k])));

  // Row order. Normalised position in its column, so columns of different heights compare.
  const rel: Record<string, number> = {};
  const idx: Record<string, number> = {};
  const index = (c: string[]) =>
    c.forEach((k, i) => {
      idx[k] = i;
      rel[k] = (i + 0.5) / c.length;
    });
  const bary = (k: string, nb: string[]) => (nb.length ? nb.reduce((s, x) => s + rel[x]!, 0) / nb.length : rel[k]!);
  const sortBy = (c: string[], nb: (k: string) => string[]) => {
    const b = new Map(c.map((k) => [k, bary(k, nb(k).filter((x) => rel[x] != null))]));
    c.sort((x, y) => b.get(x)! - b.get(y)!); // stable: ties keep the previous order
    index(c);
  };
  // First pass (the mockup's): roots by key, then each column by its blockers.
  cols[0]?.sort((a, b) => a.localeCompare(b));
  cols.forEach((c, i) => (i === 0 ? index(c) : sortBy(c, preds)));
  // Then sweep back and forth to cut crossings, keeping the best order seen.
  let best = cols.map((c) => [...c]);
  let bestX = countCrossings(edges, depth, idx);
  for (let it = 0; it < 8 && bestX > 0; it++) {
    if (it % 2 === 0) for (let i = cols.length - 2; i >= 0; i--) sortBy(cols[i]!, succs);
    else for (let i = 1; i < cols.length; i++) sortBy(cols[i]!, preds);
    const x = countCrossings(edges, depth, idx);
    if (x < bestX) {
      bestX = x;
      best = cols.map((c) => [...c]);
    }
  }

  // Coordinates. A column taller than maxRows is split into sub-columns, filled row by row so
  // the vertical order (and with it the crossing reduction) is kept.
  const maxRows = Math.max(12, Math.ceil(Math.sqrt(vis.size) * 1.6));
  const out: Positions = {};
  let x0 = 0;
  best.forEach((c) => {
    const sub = Math.ceil(c.length / maxRows),
      rows = Math.ceil(c.length / sub);
    c.forEach((k, i) => {
      const r = Math.floor(i / sub),
        inRow = Math.min(sub, c.length - r * sub);
      out[k] = { x: x0 + (i % sub) * SUBW + ((sub - inRow) * SUBW) / 2, y: (r - (rows - 1) / 2) * ROWH };
    });
    x0 += (sub - 1) * SUBW + COLW;
  });
  const warnings = cycles.size
    ? [`Blocking cycle between ${[...cycles].sort().join(', ')}. Some arrows point backwards.`]
    : [];
  return { pos: out, warnings };
}

export function layoutGraph(g: Graph, vis: Set<string>, rand: () => number = Math.random): Positions {
  const ks = [...vis];
  const E: [string, string][] = [];
  ks.forEach((k) => (g.by.get(k) ?? []).forEach((b) => vis.has(b) && E.push([b, k])));
  return forceLayout(ks, E, rand);
}

/** Above this many tickets, repulsion uses a Barnes-Hut quadtree instead of every pair. */
export const EXACT_MAX = 150;
const REPEL = 14000;
const THETA2 = 0.81; // theta 0.9

/** Barnes-Hut quadtree in flat typed arrays (an object per cell was too slow to rebuild 300 times). */
class QuadTree {
  cap = 0;
  len = 0;
  cx = new Float64Array(0);
  cy = new Float64Array(0);
  m = new Float64Array(0);
  x0 = new Float64Array(0);
  y0 = new Float64Array(0);
  size = new Float64Array(0);
  /** Body index in a leaf, -1 empty, -2 internal. */
  body = new Int32Array(0);
  kid = new Int32Array(0);

  private grow(min: number) {
    const cap = Math.max(min, this.cap * 2, 64);
    const f = (o: Float64Array) => {
      const a = new Float64Array(cap);
      a.set(o);
      return a;
    };
    this.cx = f(this.cx);
    this.cy = f(this.cy);
    this.m = f(this.m);
    this.x0 = f(this.x0);
    this.y0 = f(this.y0);
    this.size = f(this.size);
    const b = new Int32Array(cap);
    b.set(this.body);
    this.body = b;
    const k = new Int32Array(cap * 4).fill(-1);
    k.set(this.kid);
    this.kid = k;
    this.cap = cap;
  }

  private cell(x: number, y: number, size: number): number {
    if (this.len === this.cap) this.grow(this.len + 1);
    const c = this.len++;
    this.x0[c] = x;
    this.y0[c] = y;
    this.size[c] = size;
    this.m[c] = 0;
    this.cx[c] = 0;
    this.cy[c] = 0;
    this.body[c] = -1;
    this.kid.fill(-1, c * 4, c * 4 + 4);
    return c;
  }

  private child(c: number, px: number, py: number): number {
    const h = this.size[c]! / 2;
    const q = (px >= this.x0[c]! + h ? 1 : 0) | (py >= this.y0[c]! + h ? 2 : 0);
    let k = this.kid[c * 4 + q]!;
    if (k < 0) {
      k = this.cell(this.x0[c]! + (q & 1 ? h : 0), this.y0[c]! + (q & 2 ? h : 0), h);
      this.kid[c * 4 + q] = k;
    }
    return k;
  }

  build(X: Float64Array, Y: Float64Array, n: number) {
    this.len = 0;
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      x0 = Math.min(x0, X[i]!);
      y0 = Math.min(y0, Y[i]!);
      x1 = Math.max(x1, X[i]!);
      y1 = Math.max(y1, Y[i]!);
    }
    this.cell(x0, y0, Math.max(x1 - x0, y1 - y0, 1));
    for (let i = 0; i < n; i++) {
      const px = X[i]!,
        py = Y[i]!;
      let c = 0;
      for (let depth = 0; ; depth++) {
        const m = this.m[c]!;
        this.cx[c] = (this.cx[c]! * m + px) / (m + 1);
        this.cy[c] = (this.cy[c]! * m + py) / (m + 1);
        this.m[c] = m + 1;
        if (m === 0) {
          this.body[c] = i;
          break;
        }
        if (depth > 24) break; // coincident points: just add mass
        const old = this.body[c]!;
        if (old >= 0) {
          // Split the leaf: move its body one level down (its mass is already counted here).
          this.body[c] = -2;
          const k = this.child(c, X[old]!, Y[old]!);
          this.m[k] = 1;
          this.cx[k] = X[old]!;
          this.cy[k] = Y[old]!;
          this.body[k] = old;
        }
        c = this.child(c, px, py);
      }
    }
  }
}

/** Force-directed layout (the mockup's constants). Pure, so it also runs in the layout worker. */
export function forceLayout(ks: string[], E: [string, string][], rand: () => number = Math.random): Positions {
  const n = ks.length;
  const at = new Map(ks.map((k, i) => [k, i]));
  const X = new Float64Array(n),
    Y = new Float64Array(n),
    VX = new Float64Array(n),
    VY = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    X[i] = Math.cos(a) * 220 + (rand() - 0.5) * 20;
    Y[i] = Math.sin(a) * 220 + (rand() - 0.5) * 20;
  }
  const ES = new Int32Array(E.length),
    ET = new Int32Array(E.length);
  E.forEach(([s, t], i) => ((ES[i] = at.get(s)!), (ET[i] = at.get(t)!)));
  const exact = n <= EXACT_MAX;
  // Big maps settle well before 500 steps; the cooling schedule is stretched to match.
  const ITER = exact ? 500 : 300;
  const tree = exact ? null : new QuadTree();
  const stack = new Int32Array(512);
  for (let it = 0; it < ITER; it++) {
    const cool = 1 - it / ITER;
    if (!tree) {
      for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++) {
          const dx = X[i]! - X[j]!,
            dy = Y[i]! - Y[j]!,
            d2 = dx * dx + dy * dy + 0.01,
            d = Math.sqrt(d2);
          const f = REPEL / d2 / d;
          VX[i] += dx * f;
          VY[i] += dy * f;
          VX[j] -= dx * f;
          VY[j] -= dy * f;
        }
    } else {
      tree.build(X, Y, n);
      const { cx, cy, m, size, body, kid } = tree;
      for (let i = 0; i < n; i++) {
        const ax = X[i]!,
          ay = Y[i]!;
        let fx = 0,
          fy = 0,
          sp = 0;
        stack[sp++] = 0;
        while (sp) {
          const c = stack[--sp]!;
          const b = body[c]!;
          if (b === i) continue;
          const dx = ax - cx[c]!,
            dy = ay - cy[c]!,
            d2 = dx * dx + dy * dy + 0.01;
          const sz = size[c]!;
          if (b !== -2 || sz * sz < THETA2 * d2) {
            const d = Math.sqrt(d2),
              f = (REPEL * m[c]!) / d2 / d;
            fx += dx * f;
            fy += dy * f;
          } else
            for (let q = 0; q < 4; q++) {
              const k = kid[c * 4 + q]!;
              if (k >= 0) stack[sp++] = k;
            }
        }
        VX[i] += fx;
        VY[i] += fy;
      }
    }
    for (let e = 0; e < ES.length; e++) {
      const s = ES[e]!,
        t = ET[e]!;
      const dx = X[t]! - X[s]!,
        dy = Y[t]! - Y[s]!,
        d = Math.hypot(dx, dy) || 1;
      const f = ((d - 130) * 0.06) / d;
      VX[s] += dx * f;
      VY[s] += dy * f;
      VX[t] -= dx * f;
      VY[t] -= dy * f;
    }
    const cap = 30 * cool + 2;
    for (let i = 0; i < n; i++) {
      let vx = (VX[i]! - X[i]! * 0.012) * 0.6,
        vy = (VY[i]! - Y[i]! * 0.012) * 0.6;
      const sp = Math.hypot(vx, vy);
      if (sp > cap) {
        vx *= cap / sp;
        vy *= cap / sp;
      }
      VX[i] = vx;
      VY[i] = vy;
      X[i] += vx;
      Y[i] += vy;
    }
  }
  const out: Positions = {};
  ks.forEach((k, i) => (out[k] = { x: X[i]!, y: Y[i]! }));
  return out;
}

/** Graph-mode node radius grows with how much downstream work depends on the ticket. */
export function radius(g: Graph, k: string): number {
  return 11 + Math.min(descendants(g, k).size, 7) * 2.2;
}
