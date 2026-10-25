import { workOrder } from '../graph/model';
import type { AppState } from '../state';
import { $, esc } from './dom';

function row(st: AppState, k: string) {
  const t = st.graph.byKey.get(k)!;
  const w = t.isMine ? 'You' : t.assignee ? esc(t.assignee.initials) : '—';
  return `<div class="wrow${t.isMine ? ' me' : ''}" data-k="${esc(k)}"><span class="k">${esc(k)}</span><span class="t">${esc(t.summary)}</span><span class="who">${w}</span></div>`;
}

export function renderOrder(st: AppState) {
  const { waves, cyclic } = workOrder(st.graph, st.visible.vis);
  const html = waves.map(
    (w, i) => `<div class="wave"><h3>${i === 0 ? 'Start now' : 'Wave ' + (i + 1)}</h3>
    <p>${i === 0 ? 'Every blocker is done.' : 'Opens once wave ' + i + ' is done.'}</p>
    ${w.map((k) => row(st, k)).join('')}</div>`,
  );
  if (cyclic.length)
    html.push(`<div class="wave"><h3>Stuck in a cycle</h3>
    <p>These tickets block each other, or wait on tickets that do. Break one link in Jira to order them.</p>
    ${cyclic.map((k) => row(st, k)).join('')}</div>`);
  $('pane-order').innerHTML = html.join('') || '<div class="empty-state">Everything in this view is done.</div>';
}
