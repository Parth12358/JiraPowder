// Boot, state, wiring.
import './styles.css';
import { api, inApp, onMenu, toAppError } from './api';
import { buildGraph, computeVisible, defaultSprint, sprintOptions } from './graph/model';
import { SAMPLE_INITIAL_SELECTION, cycleSnapshot, sampleSnapshot } from './sample';
import type { AppState, Mode } from './state';
import type { Config, Snapshot } from './types';
import { $, esc } from './ui/dom';
import { renderInsp } from './ui/inspector';
import { renderList } from './ui/list';
import { createMap } from './ui/map';
import { renderOrder } from './ui/order';
import { initSettings, openSettings } from './ui/settings';
import { renderStatus } from './ui/status';

const demo =
  import.meta.env.DEV && new URLSearchParams(location.search).get('demo') === 'cycle' ? cycleSnapshot() : sampleSnapshot();
const st: AppState = {
  snapshot: demo,
  graph: buildGraph(demo.tickets),
  demo: true,
  filter: { sprint: 'all', mine: false },
  visible: { base: new Set(), vis: new Set() },
  mode: 'flow',
  sel: SAMPLE_INITIAL_SELECTION,
  pos: {},
  view: { x: 0, y: 0, s: 1 },
  loading: false,
  error: null,
  warnings: [],
};
let config: Config | null = null;

const map = createMap(st, (k) => select(k));

/* ---------- derived state ---------- */
function renderSprintPicker() {
  const opts = sprintOptions(st.snapshot);
  const values = new Set(opts.map((o) => o.value));
  if (st.filter.sprint !== 'all' && !values.has(st.filter.sprint)) st.filter.sprint = defaultSprint(opts);
  $('sprint').innerHTML =
    opts.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('') + '<option value="all">All sprints</option>';
  ($('sprint') as HTMLSelectElement).value = st.filter.sprint;
}

function computeVis(pickDefault = false) {
  st.visible = computeVisible(st.graph, st.snapshot.tickets, st.filter);
  const { base, vis } = st.visible;
  if ((pickDefault && !st.sel) || (st.sel && !vis.has(st.sel))) {
    const g = st.graph;
    st.sel = [...base].find((k) => g.byKey.get(k)!.isMine && g.byKey.get(k)!.status !== 'done') ?? [...base][0] ?? null;
  }
}

function renderPanels() {
  renderList(st);
  renderInsp(st, inApp() && !st.demo);
  renderOrder(st);
  renderEmpty();
  renderStatus(st, noticeHandlers);
}

function renderEmpty() {
  const empty = st.visible.base.size === 0;
  $('stage-empty').hidden = !empty;
  $('stage-empty-msg').textContent = st.filter.mine ? 'None of your tickets are in this sprint.' : 'No tickets in this sprint.';
}

/** Filter changed: rebuild and lay out from scratch (mockup behaviour). */
function full(pickDefault = false) {
  computeVis(pickDefault);
  map.build();
  st.pos = {};
  map.relayout({ animate: false });
  map.highlight();
  renderPanels();
}

function select(k: string | null) {
  st.sel = k;
  map.highlight();
  renderPanels();
}

function setMode(m: Mode) {
  st.mode = m;
  $('m-flow').setAttribute('aria-pressed', String(m === 'flow'));
  $('m-graph').setAttribute('aria-pressed', String(m === 'graph'));
  map.relayout();
  map.highlight();
  renderStatus(st, noticeHandlers);
}

/** New data arrived: keep selection, zoom and dragged positions for tickets that still exist. */
function applySnapshot(snap: Snapshot, isDemo: boolean, firstPaint = false) {
  const prevDemo = st.demo;
  st.snapshot = snap;
  st.graph = buildGraph(snap.tickets);
  st.demo = isDemo;
  st.warnings = [...snap.warnings];
  if (firstPaint || prevDemo !== isDemo) {
    st.filter.sprint = defaultSprint(sprintOptions(snap));
    renderSprintPicker();
    if (!isDemo) st.sel = null;
    full(true);
    return;
  }
  renderSprintPicker();
  computeVis();
  map.build();
  for (const k of Object.keys(st.pos)) if (!st.visible.vis.has(k)) delete st.pos[k];
  map.relayout({ animate: false, keep: true, fit: false });
  map.highlight();
  renderPanels();
}

/* ---------- Jira ---------- */
const isConfigured = (c: Config | null) => !!c && (c.useFakeServer || (!!c.server.command && (!!c.projectKey || !!c.customJql)));

let inflight: Promise<void> | null = null;
function refresh(): Promise<void> {
  if (!inApp() || !isConfigured(config)) {
    openSettings();
    return Promise.resolve();
  }
  if (inflight) return inflight;
  st.loading = true;
  renderStatus(st, noticeHandlers);
  inflight = api
    .fetchSnapshot()
    .then((snap) => {
      st.error = null;
      applySnapshot(snap, false);
    })
    .catch((e) => {
      st.error = toAppError(e);
    })
    .finally(() => {
      st.loading = false;
      inflight = null;
      renderStatus(st, noticeHandlers);
    });
  return inflight;
}

const noticeHandlers = {
  retry: () => void refresh(),
  diagnostics: () => void openSettings('diagnostics'),
  settings: () => void openSettings(),
};

/* ---------- timer refresh: only while the window is visible ---------- */
let timer = 0;
function scheduleTimer() {
  clearInterval(timer);
  const m = config?.refreshMinutes ?? 0;
  if (m > 0 && !document.hidden && !st.demo) timer = window.setInterval(() => void refresh(), m * 60_000);
}
document.addEventListener('visibilitychange', scheduleTimer);

/* ---------- wiring ---------- */
$('m-flow').onclick = () => setMode('flow');
$('m-graph').onclick = () => setMode('graph');
$('sprint').onchange = () => {
  st.filter.sprint = ($('sprint') as HTMLSelectElement).value;
  full();
};
$('mine').onchange = () => {
  st.filter.mine = ($('mine') as HTMLInputElement).checked;
  full();
};
$('q').oninput = () => renderList(st);
function setTab(t: 'list' | 'order') {
  $('tab-list').setAttribute('aria-selected', String(t === 'list'));
  $('tab-order').setAttribute('aria-selected', String(t === 'order'));
  $('pane-list').hidden = t !== 'list';
  $('pane-order').hidden = t !== 'order';
}
$('tab-list').onclick = () => setTab('list');
$('tab-order').onclick = () => setTab('order');
$('refresh').onclick = () => void refresh();
$('open-settings').onclick = () => void openSettings();
$('change-scope').onclick = () => void openSettings('jira');

function toggleInspector() {
  const btn = $('insp-toggle');
  const open = btn.getAttribute('aria-expanded') !== 'true';
  btn.setAttribute('aria-expanded', String(open));
  btn.setAttribute('aria-label', (open ? 'Hide' : 'Show') + ' ticket details');
  btn.querySelector('.lbl')!.textContent = open ? 'Hide' : 'Show';
  $('insp').hidden = !open;
  document.querySelector('.work')!.classList.toggle('collapsed', !open);
  requestAnimationFrame(() => map.fit(true));
}
$('insp-toggle').onclick = toggleInspector;

document.addEventListener('click', (e) => {
  const target = e.target as Element;
  const open = target.closest<HTMLElement>('[data-open]');
  if (open) {
    api.openInJira(open.dataset.open!).catch((err) => {
      st.error = toAppError(err);
      renderStatus(st, noticeHandlers);
    });
    return;
  }
  const d = target.closest<HTMLElement>('[data-k]');
  if (d && !d.closest('svg')) select(d.dataset.k!);
});
document.addEventListener('keydown', (e) => {
  const target = e.target as Element;
  if (e.key === 'Enter' || (e.key === ' ' && target.matches?.('.item[data-k]'))) {
    const d = target.closest?.<HTMLElement>('.item[data-k]');
    if (d) {
      e.preventDefault();
      select(d.dataset.k!);
    }
  }
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || e.altKey || $<HTMLDialogElement>('settings').open) return;
  const k = e.key.toLowerCase();
  if (k === 'f') {
    e.preventDefault();
    setTab('list');
    $('q').focus();
  } else if (k === '1') {
    e.preventDefault();
    setMode('flow');
  } else if (k === '2') {
    e.preventDefault();
    setMode('graph');
  } else if (k === 'i') {
    e.preventDefault();
    toggleInspector();
  } else if (!inApp() && k === ',') {
    // In the app these come from the native menu (see src-tauri/src/lib.rs).
    e.preventDefault();
    openSettings();
  }
});
addEventListener('resize', () => map.fit());

initSettings({
  saved(cfg) {
    config = cfg;
    st.error = null;
    scheduleTimer();
    void refresh();
  },
});

/* ---------- boot ---------- */
async function boot() {
  applySnapshot(demo, true, true);
  if (!inApp()) return;
  void onMenu((a) => (a === 'refresh' ? void refresh() : void openSettings()));
  try {
    config = await api.getConfig();
  } catch {
    config = null;
  }
  if (!isConfigured(config)) {
    // First launch: open Settings once.
    try {
      if (!localStorage.getItem('blockmap.settingsShown')) {
        localStorage.setItem('blockmap.settingsShown', '1');
        void openSettings();
      }
    } catch {
      void openSettings();
    }
    return;
  }
  try {
    const cached = await api.loadCachedSnapshot();
    if (cached) applySnapshot(cached, false, true);
  } catch {
    /* no cache yet */
  }
  scheduleTimer();
  await refresh();
}
void boot();
