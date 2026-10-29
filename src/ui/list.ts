import { isReady, openBlockers } from '../graph/model';
import type { AppState } from '../state';
import type { Ticket } from '../types';
import { $, esc } from './dom';

export function statePill(st: AppState, t: Ticket): string {
  if (t.status === 'done') return '<span class="pill p-done">Done</span>';
  if (isReady(st.graph, t.key)) return '<span class="pill p-ready">Ready</span>';
  return `<span class="pill p-blocked">Blocked · ${openBlockers(st.graph, t.key).length}</span>`;
}

export const who = (t: Ticket) => (t.isMine ? 'You' : t.assignee ? esc(t.assignee.name) : 'Unassigned');
export const pts = (t: Ticket) => (t.points == null ? 'No estimate' : `${t.points} pts`);

export function renderList(st: AppState) {
  const q = $<HTMLInputElement>('q').value.trim().toLowerCase();
  const { base } = st.visible;
  const ks = [...base].filter((k) => {
    const t = st.graph.byKey.get(k)!;
    if (!q) return true;
    const n = st.notes[k];
    const hay = [k, t.summary, t.assignee?.name ?? '', n?.tag ?? '', ...(n?.comments.map((c) => c.text) ?? [])].join(' ');
    return hay.toLowerCase().includes(q);
  });
  $('count').textContent = base.size + (base.size === 1 ? ' ticket' : ' tickets');
  $('list').innerHTML =
    ks
      .map((k) => {
        const t = st.graph.byKey.get(k)!;
        const n = st.notes[k];
        const tag = n?.tag ? `<i class="tag-dot" style="--tag:var(--tag-${n.tag})" title="${n.tag} tag"></i>` : '';
        const cms = n?.comments.length ? `<span class="cm-n" title="Your comments">${n.comments.length} note${n.comments.length === 1 ? '' : 's'}</span>` : '';
        return `<div class="item${k === st.sel ? ' sel' : ''}" data-k="${esc(k)}" tabindex="0">
    <span class="k">${tag}${esc(k)}</span>${statePill(st, t)}<span class="t">${esc(t.summary)}</span>
    <span class="meta"><span>${who(t)}</span><span>${esc(t.statusName)}</span><span>${pts(t)}</span>${cms}</span></div>`;
      })
      .join('') ||
    (base.size
      ? '<div class="empty-state">No tickets match that filter.</div>'
      : '<div class="empty-state">No tickets in this view.</div>');
}
