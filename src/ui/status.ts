// Header source label, "Updated …" line, and the one-line notice bar.
import type { AppState } from '../state';
import type { AppError } from '../types';
import { $, esc } from './dom';

export function updatedText(fetchedAt: string, now = new Date()): string {
  const t = new Date(fetchedAt);
  if (Number.isNaN(t.getTime())) return '';
  const mins = Math.floor((now.getTime() - t.getTime()) / 60000);
  if (mins < 60) return `Updated ${t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}`;
  const h = Math.floor(mins / 60);
  return h < 48 ? `Updated ${h}h ago` : `Updated ${Math.floor(h / 24)}d ago`;
}

export function errorText(e: AppError): string {
  if (e.kind === 'AuthRequired') return 'Sign in to Atlassian in the browser window that opened, then Retry.';
  return e.message;
}

export interface NoticeHandlers {
  retry(): void;
  diagnostics(): void;
  settings(): void;
}

export function renderStatus(st: AppState, h: NoticeHandlers) {
  $('src-label').textContent = st.demo ? 'Demo data' : st.snapshot.scopeLabel;
  $('upd').innerHTML = st.loading
    ? '<span class="busy"><i class="spin" aria-hidden="true"></i>Refreshing…</span>'
    : st.demo
      ? ''
      : esc(updatedText(st.snapshot.fetchedAt));
  ($('refresh') as HTMLButtonElement).disabled = st.loading;

  const n = $('notice');
  let html = '';
  let cls = '';
  if (st.error) {
    cls = 'n-error';
    html = `<span class="mark" aria-hidden="true">!</span><span class="msg">${esc(errorText(st.error))}</span>
      <span class="acts"><button class="act sm" data-n="retry">Retry</button><button class="act sm" data-n="diagnostics">Diagnostics</button></span>`;
  } else if (st.demo) {
    cls = 'n-demo';
    html = `<span class="mark" aria-hidden="true"></span><span class="msg"><b>Demo data.</b> Connect Jira in Settings.</span>
      <span class="acts"><button class="act sm" data-n="settings">Open Settings</button></span>`;
  } else if (st.warnings.length) {
    cls = 'n-warn';
    html = `<span class="mark" aria-hidden="true">i</span><span class="msg">${st.warnings.map(esc).join(' ')}</span>`;
  }
  n.className = 'notice ' + cls;
  n.innerHTML = html;
  n.hidden = !html;
  document.querySelector('.app')!.classList.toggle('has-notice', !!html);
  n.querySelectorAll<HTMLButtonElement>('[data-n]').forEach((b) => {
    b.onclick = () => h[b.dataset.n as keyof NoticeHandlers]();
  });
}
