import { descendants, openBlockers, pathToStart } from '../graph/model';
import type { AppState } from '../state';
import { $, esc } from './dom';

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function renderInsp(st: AppState, canOpen: boolean) {
  const el = $('insp');
  const sel = st.sel;
  const t = sel ? st.graph.byKey.get(sel) : undefined;
  if (!sel || !t) {
    el.innerHTML = '<div class="empty-state">Select a ticket to see what blocks it and what it unblocks.</div>';
    return;
  }
  const g = st.graph;
  const ob = openBlockers(g, sel),
    down = descendants(g, sel),
    by = g.by.get(sel) ?? [],
    blocks = g.rev.get(sel) ?? [];
  const anc = pathToStart(g, sel);
  const lk = (k: string) => {
    const x = g.byKey.get(k)!;
    return `<div class="lk" data-k="${esc(k)}"><span class="k">${esc(k)}</span><span class="t">${esc(x.summary)}</span><span class="st${x.status === 'done' ? ' done' : ''}">${esc(x.statusName)}</span></div>`;
  };
  const banner =
    t.status === 'done'
      ? `<div class="banner b-done"><strong>Done</strong>Finished work. ${plural(down.size, 'downstream ticket')} depended on this.</div>`
      : ob.length
        ? `<div class="banner b-blocked"><strong>Blocked by ${plural(ob.length, 'open ticket')}</strong>${plural(anc.length, 'ticket')} upstream still need to close before you can start.</div>`
        : `<div class="banner b-ready"><strong>Ready to start</strong>Every blocker is done.${down.size ? ` Finishing this moves ${plural(down.size, 'ticket')} closer.` : ''}</div>`;
  const inBase = st.visible.base.has(sel);
  const sprint = t.sprint?.name ?? 'No sprint';
  const assignee = t.isMine ? `You (${esc(t.assignee?.name ?? '')})` : t.assignee ? esc(t.assignee.name) : 'Unassigned';
  el.innerHTML = `<div class="insp">
    <div><div class="ik">${esc(sel)}${inBase ? '' : ' · ' + esc(sprint)}</div><h2>${esc(t.summary)}</h2></div>
    <dl class="facts"><div><dt>Status</dt><dd>${esc(t.statusName)}</dd></div><div><dt>Assignee</dt><dd>${assignee}</dd></div><div><dt>Sprint</dt><dd>${esc(sprint)}</dd></div><div><dt>Estimate</dt><dd>${t.points == null ? 'None' : plural(t.points, 'point')}</dd></div></dl>
    ${banner}
    <div class="sec"><h4 style="color:var(--blocking-ink)"><i style="background:var(--blocking-ink)"></i>Blocking this ticket</h4>
      ${by.length ? by.map(lk).join('') : '<p class="empty">Nothing blocks this ticket.</p>'}</div>
    <div class="sec"><h4 style="color:var(--blocked-by-ink)"><i style="background:var(--blocked-by-ink)"></i>This ticket blocks</h4>
      ${blocks.length ? blocks.map(lk).join('') : '<p class="empty">Nothing is waiting on this ticket.</p>'}
      ${down.size > blocks.length ? `<p class="note">${down.size} tickets downstream in total.</p>` : ''}</div>
    ${anc.length ? `<div class="sec"><h4>Path to start</h4><ol class="path">${anc.map((k) => `<li data-k="${esc(k)}"><span class="k">${esc(k)}</span><span>${esc(g.byKey.get(k)!.summary)}</span></li>`).join('')}</ol></div>` : ''}
    ${canOpen ? `<button class="act sm open-jira" id="open-jira" data-open="${esc(sel)}">Open in Jira</button>` : ''}
  </div>`;
}
