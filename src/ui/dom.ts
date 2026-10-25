export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export const NS = 'http://www.w3.org/2000/svg';

export function mk(tag: string, attrs: Record<string, string | number> = {}, parent?: Element): SVGElement {
  const e = document.createElementNS(NS, tag) as SVGElement;
  for (const a in attrs) e.setAttribute(a, String(attrs[a]));
  parent?.appendChild(e);
  return e;
}

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
