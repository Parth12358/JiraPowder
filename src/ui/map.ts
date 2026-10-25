// SVG map: build nodes/edges, draw, highlight, pan, wheel zoom, drag. Ported from the mockup.
import { ancestors, descendants, readiness } from '../graph/model';
import { CH, CW, EXACT_MAX, forceLayout, layoutFlow, radius, type Positions } from '../graph/layout';
import type { AppState } from '../state';
import type { Priority, Ticket } from '../types';
import { $, mk, reduceMotion } from './dom';

export interface MapApi {
  /** Rebuild every node and edge from state (call after the visible set changes). */
  build(): void;
  /** Lay out again. `keep` keeps existing positions and only places new tickets. */
  relayout(opts?: { animate?: boolean; keep?: boolean; fit?: boolean }): void;
  highlight(): void;
  /** `all` zooms out as far as needed to show every ticket; otherwise stays readable. */
  fit(smooth?: boolean, all?: boolean): void;
  zoomBy(f: number): void;
}

const PRI_ICON: Record<Priority, 'high' | 'med' | 'low' | null> = {
  highest: 'high',
  high: 'high',
  med: 'med',
  low: 'low',
  lowest: 'low',
  none: null,
};
const PRI_WORD: Record<Priority, string> = {
  highest: 'Highest',
  high: 'High',
  med: 'Medium',
  low: 'Low',
  lowest: 'Lowest',
  none: 'No',
};

function wrap(str: string, max: number, maxLines: number): string[] {
  const words = str.split(' '),
    lines: string[] = [];
  let cur = '';
  words.forEach((w) => {
    if ((cur + ' ' + w).trim().length > max && cur) {
      lines.push(cur);
      cur = w;
    } else cur = (cur + ' ' + w).trim();
  });
  if (cur) lines.push(cur);
  // A single word longer than a line is cut too.
  const cut = lines.map((l) => (l.length > max ? l.slice(0, max - 1) + '…' : l));
  if (cut.length > maxLines) {
    const keep = cut.slice(0, maxLines);
    keep[maxLines - 1] = keep[maxLines - 1]!.slice(0, max - 1) + '…';
    return keep;
  }
  return cut;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** Zoom thresholds for the detail levels: below FAR cards show only key + colours, below MID no shadows. */
const LOD_FAR = 0.42;
const LOD_MID = 0.75;
const MIN_ZOOM = 0.08;
/** From this many visible tickets, drop shadows and hover/dim transitions everywhere. */
const MANY = 120;
/** Off-screen margin (screen px) kept drawn so panning doesn't pop. */
const CULL_PAD = 160;

let worker: Worker | null | undefined;
let workerReq = 0;
/** Force layout for big maps in a worker so the window never freezes; falls back to the UI thread. */
function graphLayout(keys: string[], edges: [string, string][]): Positions | Promise<Positions> {
  if (keys.length <= EXACT_MAX || typeof Worker === 'undefined') return forceLayout(keys, edges);
  try {
    worker ??= new Worker(new URL('../graph/layout.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    worker = null;
  }
  const w = worker;
  if (!w) return forceLayout(keys, edges);
  const id = ++workerReq;
  return new Promise((resolve) => {
    const done = (pos: Positions) => {
      clearTimeout(timer);
      w.removeEventListener('message', onMsg);
      w.removeEventListener('error', onErr);
      resolve(pos);
    };
    const onMsg = (e: MessageEvent<{ id: number; pos: Positions }>) => e.data.id === id && done(e.data.pos);
    const onErr = () => {
      worker = null; // don't try a broken worker again
      done(forceLayout(keys, edges));
    };
    const timer = setTimeout(onErr, 5000);
    w.addEventListener('message', onMsg);
    w.addEventListener('error', onErr);
    w.postMessage({ id, keys, edges });
  });
}

function typeIcon(p: Element, ty: Ticket['type'], x: number, y: number) {
  const g = mk('g', { transform: `translate(${x},${y})`, class: 'ti-' + ty }, p);
  mk('rect', { class: 'ti', width: 16, height: 16, rx: 3 }, g);
  if (ty === 'story') mk('path', { class: 'tg', d: 'M5 4h6v8.5l-3-2.2-3 2.2z' }, g);
  else if (ty === 'task') mk('path', { class: 'tg', d: 'M4.5 8.2l2.4 2.4 4.6-5' }, g);
  else if (ty === 'bug') {
    mk('circle', { class: 'tg', cx: 8, cy: 8, r: 3.6 }, g);
    mk('circle', { class: 'tgf', cx: 8, cy: 8, r: 1.3 }, g);
  } else mk('rect', { class: 'tgf', x: 5.5, y: 5.5, width: 5, height: 5, rx: 1 }, g);
}

function priIcon(p: Element, pr: Priority, x: number, y: number) {
  const icon = PRI_ICON[pr];
  if (!icon) return;
  const g = mk('g', { transform: `translate(${x},${y})`, class: 'pri p-' + icon }, p);
  if (icon === 'high') {
    mk('path', { d: 'M-5 0l5-4.5 5 4.5' }, g);
    mk('path', { d: 'M-5 4.5l5-4.5 5 4.5' }, g);
  } else if (icon === 'low') mk('path', { d: 'M-5 -2l5 4.5 5-4.5' }, g);
  else {
    mk('path', { d: 'M-5 -2h10' }, g);
    mk('path', { d: 'M-5 2.5h10' }, g);
  }
}

export function createMap(st: AppState, onSelect: (k: string | null) => void): MapApi {
  const svg = $('svg') as unknown as SVGSVGElement;
  const world = $('world') as unknown as SVGGElement;
  const gE = $('edges') as unknown as SVGGElement;
  const gN = $('nodes') as unknown as SVGGElement;
  let nodeEls: Record<string, SVGElement> = {};
  let edgeEls: { s: string; t: string; el: SVGElement; hidden: boolean }[] = [];
  /** Edge indices touching each ticket, so a drag redraws only those. */
  let edgesOf = new Map<string, number[]>();
  let hiddenNodes = new Set<string>();
  let radii: Record<string, number> = {};
  let anim = 0;
  let layoutRun = 0;
  let lod = '';
  /* Stage size, cached: reading it with getBoundingClientRect right after building hundreds of
     nodes forces a layout of all of them (measured: ~400 ms per rebuild at 500 tickets). */
  let stage: { w: number; h: number } | null = null;
  const size = () => {
    if (!stage) {
      const r = svg.getBoundingClientRect();
      stage = { w: r.width || 800, h: r.height || 600 };
    }
    return stage;
  };
  new ResizeObserver(([e]) => {
    if (e && e.contentRect.width) stage = { w: e.contentRect.width, h: e.contentRect.height };
  }).observe(svg);

  function build() {
    gN.textContent = '';
    gE.textContent = '';
    nodeEls = {};
    edgeEls = [];
    edgesOf = new Map();
    hiddenNodes = new Set();
    radii = {};
    const { vis, base } = st.visible;
    const g = st.graph;
    svg.classList.toggle('many', vis.size >= MANY);
    const link = (k: string, i: number) => (edgesOf.get(k) ?? edgesOf.set(k, []).get(k)!).push(i);
    vis.forEach((k) =>
      (g.by.get(k) ?? []).forEach((b) => {
        if (!vis.has(b)) return;
        link(b, edgeEls.length);
        link(k, edgeEls.length);
        // Built detached; cull() attaches the ones on screen.
        edgeEls.push({ s: b, t: k, el: mk('path', { class: 'edge' }), hidden: true });
      }),
    );
    vis.forEach((k) => {
      const t = g.byKey.get(k)!;
      radii[k] = radius(g, k);
      const n = mk(
        'g',
        {
          class:
            'node' +
            (base.has(k) ? '' : ' ghost') +
            (t.status === 'done' ? ' done' : '') +
            (t.isMine ? ' o-mine' : t.assignee ? ' o-other' : ' o-none') +
            ' r-' +
            readiness(g, k),
          tabindex: 0,
          role: 'button',
          'aria-label': k + ' ' + t.summary,
        },
        // Built detached; cull() attaches the ones on screen.
      );
      hiddenNodes.add(k);
      // Only the current mode's shapes are built (hidden SVG still costs on every pan/zoom).
      if (st.mode === 'flow') {
        // Jira-style card: summary, epic/sprint + status lozenges, footer with type, key, priority, points, assignee
        const c = mk('g', { class: 'card' }, n),
          L = -CW / 2,
          Tp = -CH / 2,
          P = 14;
        mk('rect', { class: 'card-bg', x: L, y: Tp, width: CW, height: CH, rx: 6, filter: 'url(#lift)' }, c);
        mk('rect', { class: 'stripe', x: L + 1, y: Tp + 12, width: 3, height: CH - 24, rx: 1.5 }, c);
        // Far zoom shows only this big key (plus the colours).
        mk('text', { class: 'kbig', x: 0, y: 14, 'text-anchor': 'middle' }, c).textContent = k;
        const tx = mk('text', { class: 'ct', x: L + P, y: Tp + 25 }, c);
        wrap(t.summary, 29, 2).forEach((ln, i) => (mk('tspan', { x: L + P, dy: i ? 19 : 0 }, tx).textContent = ln));
        const sl = clip(t.statusName.toUpperCase(), 14),
          sw = sl.length * 7 + 16;
        // Ghosts show where they live (their sprint); in-scope tickets show their epic.
        const rawLab = base.has(k) ? t.epic : (t.sprint?.name ?? 'No sprint');
        if (rawLab) {
          const room = Math.floor((CW - 2 * P - sw - 8 - 16) / 6.7);
          const lab = clip(rawLab, Math.max(4, room)),
            lw = lab.length * 6.7 + 16;
          mk('rect', { class: 'loz', x: L + P, y: Tp + 57, width: lw, height: 20, rx: 4 }, c);
          mk('text', { class: 'loz-t', x: L + P + 8, y: Tp + 71 }, c).textContent = lab;
        }
        mk('rect', { class: 'sloz s-' + t.status, x: -L - P - sw, y: Tp + 57, width: sw, height: 20, rx: 4 }, c);
        mk('text', { class: 'sloz-t s-' + t.status, x: -L - P - sw / 2, y: Tp + 71, 'text-anchor': 'middle' }, c).textContent = sl;
        const fy = CH / 2 - 20;
        typeIcon(c, t.type, L + P, fy - 8);
        mk('text', { class: 'ck', x: L + P + 22, y: fy + 4 }, c).textContent = k;
        priIcon(c, t.priority, L + P + 22 + k.length * 7.3 + 10, fy);
        const ax = -L - P - 11;
        if (t.points != null) {
          const pt = String(Math.round(t.points * 10) / 10),
            pw = Math.max(26, pt.length * 7 + 12);
          const px = t.assignee ? ax - 11 - 8 - pw : -L - P - pw;
          mk('rect', { class: 'pts', x: px, y: fy - 10, width: pw, height: 20, rx: 10 }, c);
          mk('text', { class: 'pts-t', x: px + pw / 2, y: fy + 4, 'text-anchor': 'middle' }, c).textContent = pt;
        }
        if (t.assignee) {
          mk('circle', { class: 'av' + (t.isMine ? ' me' : ''), cx: ax, cy: fy, r: 11 }, c);
          mk('text', { class: 'av-t' + (t.isMine ? ' me' : ''), x: ax, y: fy + 3.5, 'text-anchor': 'middle' }, c).textContent =
            t.assignee.initials;
        }
      } else {
        const gr = mk('g', { class: 'graph' }, n),
          r = radii[k]!;
        mk('circle', { class: 'ring', r: r + 6 }, gr);
        mk('circle', { class: 'circ', r, filter: 'url(#lift)' }, gr);
        mk('circle', { class: 'sheen', r, fill: 'url(#bulb)' }, gr);
        if (t.isMine) mk('circle', { class: 'me-dot', r: 3.5 }, gr);
        mk('text', { class: 'gl', y: r + 15 }, gr).textContent = k;
      }
      const pts = t.points == null ? 'no estimate' : `${t.points} pts`;
      mk('title', {}, n).textContent =
        `${k} · ${t.summary}\n${t.typeName} · ${PRI_WORD[t.priority]} priority · ${t.statusName} · ${t.assignee?.name ?? 'Unassigned'} · ${pts}`;
      nodeEls[k] = n;
      attachDrag(n, k);
      n.addEventListener('keydown', (e) => {
        const ke = e as KeyboardEvent;
        if (ke.key === 'Enter' || ke.key === ' ') {
          ke.preventDefault();
          onSelect(k);
        }
      });
    });
  }

  /** Position nodes and edges; with `only`, just that ticket and its edges (dragging). */
  function draw(only?: string) {
    const pos = st.pos;
    const keys = only ? [only] : st.visible.vis;
    keys.forEach((k) => pos[k] && nodeEls[k]?.setAttribute('transform', `translate(${pos[k].x},${pos[k].y})`));
    const es = only ? (edgesOf.get(only) ?? []).map((i) => edgeEls[i]!) : edgeEls;
    es.forEach((e) => {
      const a = pos[e.s],
        b = pos[e.t];
      if (!a || !b) return;
      let d: string;
      if (st.mode === 'flow') {
        const x1 = a.x + CW / 2,
          y1 = a.y,
          x2 = b.x - CW / 2 - 3,
          y2 = b.y,
          dx = Math.max(40, Math.abs(x2 - x1) / 2);
        d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
      } else {
        const dx = b.x - a.x,
          dy = b.y - a.y,
          L = Math.hypot(dx, dy) || 1,
          ra = radii[e.s]! + 2,
          rb = radii[e.t]! + 5;
        d = `M${a.x + (dx / L) * ra},${a.y + (dy / L) * ra} L${b.x - (dx / L) * rb},${b.y - (dy / L) * rb}`;
      }
      e.el.setAttribute('d', d);
    });
    scheduleCull();
  }

  function applyView() {
    const v = st.view;
    world.setAttribute('transform', `translate(${v.x},${v.y}) scale(${v.s})`);
    $('zf').textContent = Math.round(v.s * 100) + '%';
    const next = v.s < LOD_FAR ? 'far' : v.s < LOD_MID ? 'mid' : 'near';
    if (next !== lod) {
      svg.classList.remove('lod-' + lod);
      svg.classList.add('lod-' + next);
      lod = next;
    }
    scheduleCull();
  }

  /* Only draw what is on screen: nodes and edges outside the view (plus a margin) are detached from
     the DOM. Hiding them with display:none is not enough: Chromium/WebKit still walk hidden SVG on
     every pan/zoom transform (measured: 500 tickets, 140 ms vs 33 ms per frame). */
  let cullQueued = false;
  function scheduleCull() {
    if (cullQueued) return;
    cullQueued = true;
    requestAnimationFrame(() => {
      cullQueued = false;
      cull();
    });
  }
  function cull() {
    const v = st.view,
      { w: W, h: H } = size();
    const pad = CULL_PAD / v.s,
      x0 = -v.x / v.s - pad,
      y0 = -v.y / v.s - pad,
      x1 = (W - v.x) / v.s + pad,
      y1 = (H - v.y) / v.s + pad;
    const flow = st.mode === 'flow';
    let reattached = false;
    const hw = (k: string) => (flow ? CW / 2 : (radii[k] ?? 11) + 20);
    const hh = (k: string) => (flow ? CH / 2 : (radii[k] ?? 11) + 24);
    st.visible.vis.forEach((k) => {
      const p = st.pos[k],
        el = nodeEls[k];
      if (!p || !el) return;
      // The selected ticket stays drawn so keyboard focus and highlight never vanish.
      const off = k !== st.sel && (p.x + hw(k) < x0 || p.x - hw(k) > x1 || p.y + hh(k) < y0 || p.y - hh(k) > y1);
      if (off !== hiddenNodes.has(k)) {
        if (off) {
          el.remove();
          hiddenNodes.add(k);
        } else {
          gN.appendChild(el);
          hiddenNodes.delete(k);
          reattached = true;
        }
      }
    });
    // Keep the selected ticket on top after re-attaching others.
    if (reattached && st.sel && nodeEls[st.sel] && !hiddenNodes.has(st.sel)) gN.appendChild(nodeEls[st.sel]);
    edgeEls.forEach((e) => {
      const a = st.pos[e.s],
        b = st.pos[e.t];
      if (!a || !b) return;
      // Flow curves bulge sideways by up to half their length; pad the box by that.
      const bulge = flow ? Math.max(40, Math.abs(b.x - a.x) / 2) + CW / 2 : 0;
      const off =
        Math.max(a.x, b.x) + bulge < x0 ||
        Math.min(a.x, b.x) - bulge > x1 ||
        Math.max(a.y, b.y) < y0 ||
        Math.min(a.y, b.y) > y1;
      if (off !== e.hidden) {
        if (off) e.el.remove();
        else gE.appendChild(e.el);
        e.hidden = off;
      }
    });
  }

  function highlight() {
    const { vis } = st.visible;
    const sel = st.sel && vis.has(st.sel) ? st.sel : null;
    const up = sel ? ancestors(st.graph, sel, vis) : new Set<string>(),
      down = sel ? descendants(st.graph, sel, vis) : new Set<string>();
    vis.forEach((k) => {
      const g = nodeEls[k]!;
      g.classList.toggle('sel', k === sel);
      g.classList.toggle('up', up.has(k));
      g.classList.toggle('down', down.has(k));
      g.classList.toggle('dim', !!sel && k !== sel && !up.has(k) && !down.has(k));
    });
    edgeEls.forEach((e) => {
      const isUp = !!sel && up.has(e.s) && (e.t === sel || up.has(e.t));
      const isDown = !!sel && down.has(e.t) && (e.s === sel || down.has(e.s));
      e.el.setAttribute('class', 'edge' + (isUp ? ' up' : isDown ? ' down' : sel ? ' dim' : ''));
      e.el.setAttribute('marker-end', `url(#a-${isUp ? 'up' : isDown ? 'down' : 'def'})`);
    });
    if (sel && nodeEls[sel]) {
      gN.appendChild(nodeEls[sel]);
      hiddenNodes.delete(sel);
    }
    scheduleCull();
  }

  function flowTarget(): Positions {
    const r = layoutFlow(st.graph, st.visible.vis);
    st.warnings = [...new Set([...st.snapshot.warnings, ...r.warnings])];
    return r.pos;
  }

  function target(): Positions | Promise<Positions> {
    if (st.mode === 'flow') return flowTarget();
    const vis = st.visible.vis,
      keys = [...vis],
      edges: [string, string][] = [];
    keys.forEach((k) => (st.graph.by.get(k) ?? []).forEach((b) => vis.has(b) && edges.push([b, k])));
    return graphLayout(keys, edges);
  }

  function relayout(opts: { animate?: boolean; keep?: boolean; fit?: boolean } = {}) {
    cancelAnimationFrame(anim);
    const run = ++layoutRun;
    const tgt = target();
    svg.setAttribute('class', svg.getAttribute('class')!.replace(/mode-\w+/, 'mode-' + st.mode));
    if (!(tgt instanceof Promise)) return place(tgt, opts);
    // Big graph layout is computing in the worker. Meanwhile give new tickets a spot (their
    // flow position) so everything can be drawn, then animate to the result.
    const missing = [...st.visible.vis].some((k) => !st.pos[k]);
    if (missing) {
      const fp = flowTarget();
      st.visible.vis.forEach((k) => (st.pos[k] ??= fp[k]!));
      draw();
      if (opts.fit !== false) fit();
    }
    void tgt.then((pos) => run === layoutRun && place(pos, opts));
  }

  function place(tgt: Positions, { animate = true, keep = false, fit: doFit = true }) {
    const vis = st.visible.vis;
    if (keep) vis.forEach((k) => st.pos[k] && (tgt[k] = st.pos[k]!));
    const from: Positions = {};
    vis.forEach((k) => (from[k] = st.pos[k] ? { ...st.pos[k]! } : { ...tgt[k]! }));
    if (!animate || reduceMotion()) {
      st.pos = tgt;
      draw();
      if (doFit) fit();
      return;
    }
    const t0 = performance.now(),
      D = 480;
    if (doFit) fitTo(tgt, true);
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / D),
        e = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
      const next: Positions = {};
      vis.forEach((k) => (next[k] = { x: from[k]!.x + (tgt[k]!.x - from[k]!.x) * e, y: from[k]!.y + (tgt[k]!.y - from[k]!.y) * e }));
      st.pos = next;
      draw();
      if (p < 1) anim = requestAnimationFrame(step);
    };
    step(t0);
  }

  function fitTo(P: Positions, smooth = false, all = false) {
    const ks = [...st.visible.vis].filter((k) => P[k]);
    if (!ks.length) return;
    const pad = st.mode === 'flow' ? { w: CW / 2 + 30, h: CH / 2 + 30 } : { w: 60, h: 60 };
    let x0 = Infinity,
      y0 = Infinity,
      x1 = -Infinity,
      y1 = -Infinity;
    ks.forEach((k) => {
      const p = P[k]!;
      x0 = Math.min(x0, p.x - pad.w);
      x1 = Math.max(x1, p.x + pad.w);
      y0 = Math.min(y0, p.y - pad.h);
      y1 = Math.max(y1, p.y + pad.h);
    });
    const W = size().w,
      H = size().h - 50;
    // never shrink below a readable zoom; if everything won't fit, center on the selected ticket
    let s = Math.min(1.3, Math.min(W / (x1 - x0), H / (y1 - y0)));
    const minS = all ? MIN_ZOOM : W < 500 ? 0.72 : 0.82;
    let cx = (x0 + x1) / 2,
      cy = (y0 + y1) / 2;
    if (s < minS) {
      s = minS;
      if (st.sel && P[st.sel]) {
        cx = P[st.sel]!.x;
        cy = P[st.sel]!.y;
      }
    }
    const tv = { s, x: W / 2 - cx * s, y: H / 2 - cy * s };
    if (!smooth || reduceMotion()) {
      st.view = tv;
      applyView();
      return;
    }
    const fv = { ...st.view },
      t0 = performance.now();
    const stp = (now: number) => {
      const p = Math.min(1, (now - t0) / 480),
        e = 1 - Math.pow(1 - p, 3);
      st.view = { s: fv.s + (tv.s - fv.s) * e, x: fv.x + (tv.x - fv.x) * e, y: fv.y + (tv.y - fv.y) * e };
      applyView();
      if (p < 1) requestAnimationFrame(stp);
    };
    stp(t0);
  }
  const fit = (smooth = false, all = false) => fitTo(st.pos, smooth, all);

  /* ---------- interaction ---------- */
  let drag: { k: string; ox: number; oy: number; sx: number; sy: number; moved: boolean } | null = null;
  function toWorld(cx: number, cy: number) {
    const r = svg.getBoundingClientRect();
    return { x: (cx - r.left - st.view.x) / st.view.s, y: (cy - r.top - st.view.y) / st.view.s };
  }
  function attachDrag(g: SVGElement, k: string) {
    g.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      const w = toWorld(e.clientX, e.clientY);
      drag = { k, ox: w.x - st.pos[k]!.x, oy: w.y - st.pos[k]!.y, sx: e.clientX, sy: e.clientY, moved: false };
      g.setPointerCapture(e.pointerId);
    });
    g.addEventListener('pointermove', (e) => {
      if (!drag || drag.k !== k) return;
      if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 3) drag.moved = true;
      if (drag.moved) {
        cancelAnimationFrame(anim);
        const w = toWorld(e.clientX, e.clientY);
        st.pos[k] = { x: w.x - drag.ox, y: w.y - drag.oy };
        draw(k);
      }
    });
    g.addEventListener('pointerup', () => {
      if (drag && !drag.moved) onSelect(k);
      drag = null;
    });
  }
  let pan: { x: number; y: number; vx: number; vy: number; moved: boolean } | null = null;
  svg.addEventListener('pointerdown', (e) => {
    pan = { x: e.clientX, y: e.clientY, vx: st.view.x, vy: st.view.y, moved: false };
    svg.setPointerCapture(e.pointerId);
    svg.classList.add('panning');
  });
  svg.addEventListener('pointermove', (e) => {
    if (!pan) return;
    const dx = e.clientX - pan.x,
      dy = e.clientY - pan.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) pan.moved = true;
    st.view.x = pan.vx + dx;
    st.view.y = pan.vy + dy;
    applyView();
  });
  svg.addEventListener('pointerup', () => {
    if (pan && !pan.moved) onSelect(null);
    pan = null;
    svg.classList.remove('panning');
  });
  svg.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    },
    { passive: false },
  );
  function zoomAt(mx: number, my: number, f: number) {
    const v = st.view;
    const s = Math.min(2.5, Math.max(MIN_ZOOM, v.s * f));
    f = s / v.s;
    v.x = mx - (mx - v.x) * f;
    v.y = my - (my - v.y) * f;
    v.s = s;
    applyView();
  }
  const zoomBy = (f: number) => zoomAt(size().w / 2, size().h / 2, f);
  $('zi').onclick = () => zoomBy(1.2);
  $('zo').onclick = () => zoomBy(1 / 1.2);
  $('zf').onclick = () => fit(true, true);

  return { build, relayout, highlight, fit, zoomBy };
}
