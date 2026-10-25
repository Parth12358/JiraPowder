// SVG map: build nodes/edges, draw, highlight, pan, wheel zoom, drag. Ported from the mockup.
import { ancestors, descendants } from '../graph/model';
import { CH, CW, layoutFlow, layoutGraph, radius, type Positions } from '../graph/layout';
import type { AppState } from '../state';
import type { Priority, Ticket } from '../types';
import { $, mk, reduceMotion } from './dom';

export interface MapApi {
  /** Rebuild every node and edge from state (call after the visible set changes). */
  build(): void;
  /** Lay out again. `keep` keeps existing positions and only places new tickets. */
  relayout(opts?: { animate?: boolean; keep?: boolean; fit?: boolean }): void;
  highlight(): void;
  fit(smooth?: boolean): void;
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
  let edgeEls: { s: string; t: string; el: SVGElement }[] = [];
  let radii: Record<string, number> = {};
  let anim = 0;

  function build() {
    gN.textContent = '';
    gE.textContent = '';
    nodeEls = {};
    edgeEls = [];
    radii = {};
    const { vis, base } = st.visible;
    const g = st.graph;
    vis.forEach((k) =>
      (g.by.get(k) ?? []).forEach((b) => {
        if (vis.has(b)) edgeEls.push({ s: b, t: k, el: mk('path', { class: 'edge' }, gE) });
      }),
    );
    vis.forEach((k) => {
      const t = g.byKey.get(k)!;
      radii[k] = radius(g, k);
      const n = mk(
        'g',
        {
          class: 'node' + (base.has(k) ? '' : ' ghost') + (t.status === 'done' ? ' done' : ''),
          tabindex: 0,
          role: 'button',
          'aria-label': k + ' ' + t.summary,
        },
        gN,
      );
      // Jira-style card: summary, epic/sprint + status lozenges, footer with type, key, priority, points, assignee
      const c = mk('g', { class: 'card' }, n),
        L = -CW / 2,
        Tp = -CH / 2,
        P = 14;
      mk('rect', { class: 'card-bg', x: L, y: Tp, width: CW, height: CH, rx: 6, filter: 'url(#lift)' }, c);
      mk('rect', { class: 'selbar', x: L, y: Tp + 14, width: 2.5, height: CH - 28, rx: 1 }, c);
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
      const gr = mk('g', { class: 'graph' }, n),
        r = radii[k]!;
      mk('circle', { class: 'ring', r: r + 6 }, gr);
      mk('circle', { class: 'circ st-' + t.status, r, filter: 'url(#lift)' }, gr);
      mk('circle', { class: 'sheen', r, fill: 'url(#bulb)' }, gr);
      if (t.isMine) mk('circle', { class: 'me-dot', r: 3.5 }, gr);
      mk('text', { class: 'gl', y: r + 15 }, gr).textContent = k;
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

  function draw() {
    const pos = st.pos;
    st.visible.vis.forEach((k) => nodeEls[k]?.setAttribute('transform', `translate(${pos[k]!.x},${pos[k]!.y})`));
    edgeEls.forEach((e) => {
      const a = pos[e.s]!,
        b = pos[e.t]!;
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
  }

  function applyView() {
    const v = st.view;
    world.setAttribute('transform', `translate(${v.x},${v.y}) scale(${v.s})`);
    $('zf').textContent = Math.round(v.s * 100) + '%';
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
    if (sel && nodeEls[sel]) gN.appendChild(nodeEls[sel]);
  }

  function target(): Positions {
    if (st.mode === 'flow') {
      const r = layoutFlow(st.graph, st.visible.vis);
      st.warnings = [...new Set([...st.snapshot.warnings, ...r.warnings])];
      return r.pos;
    }
    return layoutGraph(st.graph, st.visible.vis);
  }

  function relayout({ animate = true, keep = false, fit: doFit = true } = {}) {
    cancelAnimationFrame(anim);
    const tgt = target();
    const vis = st.visible.vis;
    if (keep) vis.forEach((k) => st.pos[k] && (tgt[k] = st.pos[k]!));
    const from: Positions = {};
    vis.forEach((k) => (from[k] = st.pos[k] ? { ...st.pos[k]! } : { ...tgt[k]! }));
    svg.setAttribute('class', 'mode-' + st.mode);
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

  function fitTo(P: Positions, smooth = false) {
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
    const r = svg.getBoundingClientRect(),
      W = r.width || 800,
      H = (r.height || 600) - 50;
    // never shrink below a readable zoom; if everything won't fit, center on the selected ticket
    let s = Math.min(1.3, Math.min(W / (x1 - x0), H / (y1 - y0)));
    const minS = W < 500 ? 0.72 : 0.82;
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
  const fit = (smooth = false) => fitTo(st.pos, smooth);

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
        draw();
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
    const s = Math.min(2.5, Math.max(0.2, v.s * f));
    f = s / v.s;
    v.x = mx - (mx - v.x) * f;
    v.y = my - (my - v.y) * f;
    v.s = s;
    applyView();
  }
  const zoomBy = (f: number) => {
    const r = svg.getBoundingClientRect();
    zoomAt(r.width / 2, r.height / 2, f);
  };
  $('zi').onclick = () => zoomBy(1.2);
  $('zo').onclick = () => zoomBy(1 / 1.2);
  $('zf').onclick = () => fit(true);

  return { build, relayout, highlight, fit, zoomBy };
}
