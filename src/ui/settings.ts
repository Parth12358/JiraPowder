// Settings sheet: Server, Jira, Refresh, Colours, Diagnostics.
import { api, inApp, toAppError } from '../api';
import type { Config, Scope } from '../types';
import { OWNER_KEYS, PRESETS, STATE_KEYS, applyColors, loadColors, saveColors, type ColorKey, type Colors } from './colors';
import { $, esc } from './dom';

export const DEFAULT_CONFIG: Config = {
  version: 1,
  server: { command: 'uvx', args: ['mcp-atlassian'], env: { READ_ONLY_MODE: 'true' } },
  profile: 'mcp-atlassian',
  tools: {
    search: {
      name: 'jira_search',
      jqlArg: 'jql',
      fieldsArg: 'fields',
      limitArg: 'limit',
      startArg: 'start_at',
      pageTokenArg: 'page_token',
      pageSize: 50,
    },
    fields: 'jira_search_fields',
  },
  fields: { storyPoints: 'customfield_10016', sprint: 'customfield_10020' },
  site: '',
  projectKey: '',
  defaultScope: 'openSprints',
  customJql: '',
  refreshMinutes: 0,
  useFakeServer: false,
};

/** Env value the backend shows in place of a stored secret. */
const MASK = '•••';
const looksSecret = (k: string) => /token|secret|password|api_?key/i.test(k);

export interface SettingsHost {
  /** Called after a successful save. */
  saved(cfg: Config): void;
}

let host: SettingsHost;
let cfg: Config = structuredClone(DEFAULT_CONFIG);

const dlg = () => $<HTMLDialogElement>('settings');

function envRows(env: Record<string, string>) {
  const rows = Object.entries(env);
  return rows
    .map(([k, v], i) => {
      const kc = v.startsWith('keychain:');
      const shown = kc ? MASK : v;
      return `<tr data-i="${i}">
        <td><input class="in mono" data-env="k" value="${esc(k)}" aria-label="Variable name" spellcheck="false"></td>
        <td><input class="in mono" data-env="v" value="${esc(shown)}" aria-label="Value for ${esc(k)}" type="${kc || looksSecret(k) ? 'password' : 'text'}" spellcheck="false"></td>
        <td><label class="kc"><input type="checkbox" data-env="kc"${kc ? ' checked' : ''}> Keychain</label></td>
        <td><button class="x" data-env="rm" aria-label="Remove ${esc(k)}">×</button></td></tr>`;
    })
    .join('');
}

const colorRows = (keys: [ColorKey, string][], c: Colors) =>
  keys
    .map(
      ([k, label]) =>
        `<label class="crow"><input type="color" data-color="${k}" value="${c[k]}" aria-label="${label} colour"> ${label}<span class="hex">${c[k]}</span></label>`,
    )
    .join('');

function render() {
  const c = cfg;
  const colors = loadColors();
  const custom = c.profile === 'custom';
  const browserNote = inApp()
    ? ''
    : '<div class="result err">Settings are saved by the desktop app. Run <span class="kv">npm run tauri dev</span> to connect Jira.</div>';
  dlg().innerHTML = `
  <div class="sheet-h"><h2 id="settings-title">Settings</h2><button class="act icon" data-act="close" aria-label="Close settings">×</button></div>
  <form class="sheet-b" id="sf" autocomplete="off">
    ${browserNote}
    <section class="fs">
      <h3>Server</h3>
      <p>The MCP server JiraPowder starts to read Jira. Use the same command, arguments and environment as your Claude config.</p>
      <div class="field"><label for="s-profile">Profile</label>
        <select id="s-profile"><option value="mcp-atlassian"${c.profile === 'mcp-atlassian' ? ' selected' : ''}>mcp-atlassian</option><option value="custom"${custom ? ' selected' : ''}>Custom</option></select>
        <span class="help">mcp-atlassian always runs with READ_ONLY_MODE=true.</span></div>
      <div class="field"><label for="s-cmd">Command</label><input class="in mono" id="s-cmd" value="${esc(c.server.command)}" spellcheck="false"></div>
      <div class="field"><label for="s-args">Arguments</label><textarea class="in" id="s-args" rows="2" spellcheck="false">${esc(c.server.args.join('\n'))}</textarea>
        <span class="help">One argument per line.</span></div>
      <div class="field"><span class="lab">Environment</span><span class="help" style="margin:0">Tokens marked Keychain are stored in the macOS Keychain, not in the config file.</span></div>
      <table class="env"><thead><tr><th>Name</th><th>Value</th><th></th><th></th></tr></thead><tbody id="s-env">${envRows(c.server.env)}</tbody></table>
      <button type="button" class="act sm" data-act="add-env">Add variable</button>
      ${
        custom
          ? `<div class="field"><label for="t-name">Search tool</label><input class="in mono" id="t-name" value="${esc(c.tools.search.name)}"></div>
      <div class="field"><label for="t-jql">JQL argument</label><input class="in mono" id="t-jql" value="${esc(c.tools.search.jqlArg)}"></div>
      <div class="field"><label for="t-fields">Fields argument</label><input class="in mono" id="t-fields" value="${esc(c.tools.search.fieldsArg)}"></div>
      <div class="field"><label for="t-limit">Limit argument</label><input class="in mono" id="t-limit" value="${esc(c.tools.search.limitArg)}"></div>
      <div class="field"><label for="t-start">Offset argument</label><input class="in mono" id="t-start" value="${esc(c.tools.search.startArg)}"></div>
      <div class="field"><label for="t-token">Page token argument</label><input class="in mono" id="t-token" value="${esc(c.tools.search.pageTokenArg ?? '')}">
        <span class="help">Leave empty if the server pages with an offset only.</span></div>
      <div class="field"><label for="t-page">Page size</label><input class="in mono" id="t-page" type="number" min="1" max="100" value="${c.tools.search.pageSize}"></div>`
          : ''
      }
      <div class="field"><span class="lab">Fake server</span><label class="kc"><input type="checkbox" id="s-fake"${c.useFakeServer ? ' checked' : ''}> Use the built-in fake server with sample tickets</label></div>
    </section>
    <section class="fs">
      <h3>Jira</h3>
      <p>Which tickets to load. Linked tickets outside this scope appear as dotted ghosts.</p>
      <div class="field"><label for="j-site">Site URL</label><input class="in mono" id="j-site" placeholder="https://yourcompany.atlassian.net" value="${esc(c.site)}" spellcheck="false"></div>
      <div class="field"><label for="j-key">Project key</label><input class="in mono" id="j-key" placeholder="PAY" value="${esc(c.projectKey)}" spellcheck="false"></div>
      <div class="field"><label for="j-scope">Scope</label>
        <select id="j-scope">${(
          [
            ['openSprints', 'Open sprints'],
            ['futureSprints', 'Future sprints'],
            ['jql', 'Custom JQL'],
          ] as [Scope, string][]
        )
          .map(([v, l]) => `<option value="${v}"${c.defaultScope === v ? ' selected' : ''}>${l}</option>`)
          .join('')}</select></div>
      <div class="field" id="j-jql-row"${c.defaultScope === 'jql' ? '' : ' hidden'}><label for="j-jql">Custom JQL</label><textarea class="in" id="j-jql" rows="3" spellcheck="false">${esc(c.customJql)}</textarea>
        <span class="help" id="j-jql-warn"${c.customJql.trim() ? ' hidden' : ''}>Enter a JQL query, or pick another scope.</span></div>
      <div class="field"><label for="f-sp">Story points field</label><div class="row"><input class="in mono" id="f-sp" value="${esc(c.fields.storyPoints)}" spellcheck="false"><button type="button" class="act sm" data-act="detect"${c.tools.fields ? '' : ' disabled'}>Detect</button></div></div>
      <div class="field"><label for="f-sprint">Sprint field</label><input class="in mono" id="f-sprint" value="${esc(c.fields.sprint)}" spellcheck="false"></div>
    </section>
    <section class="fs">
      <h3>Refresh</h3>
      <div class="field"><label for="r-min">Refresh</label>
        <select id="r-min">${[
          [0, 'Manually'],
          [5, 'Every 5 minutes'],
          [15, 'Every 15 minutes'],
          [30, 'Every 30 minutes'],
        ]
          .map(([v, l]) => `<option value="${v}"${c.refreshMinutes === v ? ' selected' : ''}>${l}</option>`)
          .join('')}</select></div>
    </section>
    <section class="fs" id="colors">
      <h3>Colours</h3>
      <p>The outline shows whose ticket it is; the stripe on the left (the fill in Graph) shows its state. Changes apply right away and are kept on this Mac.</p>
      <div class="colors">
        <div><h4>Outline: owner</h4>${colorRows(OWNER_KEYS, colors)}</div>
        <div><h4>Stripe: state</h4>${colorRows(STATE_KEYS, colors)}</div>
      </div>
      <div class="presets"><button type="button" class="act sm" data-preset="mono">Mono</button><button type="button" class="act sm" data-preset="vivid">Vivid</button></div>
    </section>
    <section class="fs" id="diag">
      <h3>Diagnostics</h3>
      <p>What the app sees when it starts the server. Secrets are masked.</p>
      <div class="row" style="display:flex;gap:8px"><button type="button" class="act sm" data-act="test"${inApp() ? '' : ' disabled'}>Test connection</button><button type="button" class="act sm" data-act="diag-load"${inApp() ? '' : ' disabled'}>Reload log</button></div>
      <div id="test-out"></div>
      <div class="field"><span class="lab">PATH</span><span class="kv" id="d-path">—</span></div>
      <pre class="log" id="d-log">No server output yet.</pre>
    </section>
  </form>
  <div class="sheet-f"><span class="status" id="s-status"></span><button class="act sm" data-act="close">Cancel</button><button class="act sm primary" data-act="save"${inApp() ? '' : ' disabled'}>Save</button></div>`;
  wire();
}

function readEnv(): { env: Record<string, string>; secrets: [string, string][] } {
  const env: Record<string, string> = {};
  const secrets: [string, string][] = [];
  const old = cfg.server.env;
  dlg()
    .querySelectorAll<HTMLTableRowElement>('#s-env tr')
    .forEach((tr) => {
      const k = tr.querySelector<HTMLInputElement>('[data-env="k"]')!.value.trim();
      const v = tr.querySelector<HTMLInputElement>('[data-env="v"]')!.value;
      const kc = tr.querySelector<HTMLInputElement>('[data-env="kc"]')!.checked;
      if (!k) return;
      const prev = old[k];
      if (v === MASK && prev != null) env[k] = prev; // unchanged secret
      else if (kc) {
        const ref = 'keychain:' + k.toLowerCase();
        secrets.push([ref.slice(9), v]);
        env[k] = ref;
      } else env[k] = v;
    });
  return { env, secrets };
}

function readForm(): { next: Config; secrets: [string, string][] } {
  const v = (id: string) => (dlg().querySelector<HTMLInputElement>('#' + id)?.value ?? '').trim();
  const { env, secrets } = readEnv();
  const next: Config = structuredClone(cfg);
  next.profile = v('s-profile') || 'mcp-atlassian';
  next.server = {
    command: v('s-cmd'),
    args: v('s-args')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
    env,
  };
  if (next.profile === 'custom' && dlg().querySelector('#t-name')) {
    next.tools.search = {
      name: v('t-name'),
      jqlArg: v('t-jql'),
      fieldsArg: v('t-fields'),
      limitArg: v('t-limit'),
      startArg: v('t-start'),
      pageTokenArg: v('t-token') || null,
      pageSize: Math.max(1, Math.min(100, Number(v('t-page')) || 50)),
    };
  }
  next.useFakeServer = dlg().querySelector<HTMLInputElement>('#s-fake')!.checked;
  next.site = v('j-site').replace(/\/+$/, '');
  next.projectKey = v('j-key').toUpperCase();
  next.defaultScope = v('j-scope') as Scope;
  next.customJql = v('j-jql');
  next.fields = { storyPoints: v('f-sp'), sprint: v('f-sprint') };
  next.refreshMinutes = Number(v('r-min')) || 0;
  return { next, secrets };
}

function validate(c: Config): string | null {
  if (!c.useFakeServer && !c.server.command) return 'Enter the command that starts your MCP server.';
  if (c.site && !/^https:\/\/[^/\s]+$/.test(c.site)) return 'Site URL must look like https://yourcompany.atlassian.net.';
  if (c.defaultScope !== 'jql' && !/^[A-Z][A-Z0-9_]+$/.test(c.projectKey)) return 'Enter a project key such as PAY.';
  if (c.defaultScope === 'jql' && !c.customJql) return 'Enter a JQL query, or pick another scope.';
  return null;
}

function setStatus(msg: string, err = false) {
  const s = dlg().querySelector<HTMLElement>('#s-status');
  if (!s) return;
  s.textContent = msg;
  s.classList.toggle('err', err);
}

async function loadDiagnostics() {
  try {
    const d = await api.getDiagnostics();
    dlg().querySelector('#d-path')!.textContent = d.path || '—';
    const last = d.lastError ? `Last error (${d.lastError.kind}): ${d.lastError.message}\n\n` : '';
    dlg().querySelector('#d-log')!.textContent = last + (d.stderr.length ? d.stderr.join('\n') : 'No server output yet.');
  } catch (e) {
    dlg().querySelector('#d-log')!.textContent = toAppError(e).message;
  }
}

async function testConnection() {
  const out = dlg().querySelector('#test-out')!;
  out.innerHTML = '<div class="result">Connecting…</div>';
  try {
    const r = await api.testConnection();
    const missing = new Set(r.missing);
    out.innerHTML = `<div class="result${missing.size ? ' err' : ''}">${
      missing.size
        ? `Connected to ${esc(r.serverName)}, but it does not offer ${[...missing].map(esc).join(', ')}.`
        : `Connected to ${esc(r.serverName)}. Read tools it offers:`
    }<ul>${[...r.missing.map((t) => `<li class="miss">${esc(t)}</li>`), ...r.tools.map((t) => `<li>${esc(t)}</li>`)].join('')}</ul></div>`;
  } catch (e) {
    out.innerHTML = `<div class="result err">${esc(toAppError(e).message)}</div>`;
  }
  loadDiagnostics();
}

async function save() {
  const { next, secrets } = readForm();
  const problem = validate(next);
  if (problem) return setStatus(problem, true);
  setStatus('Saving…');
  try {
    for (const [name, value] of secrets) if (value && value !== MASK) await api.setSecret(name, value);
    await api.saveConfig(next);
    cfg = next;
    setStatus('Saved. Testing connection…');
    await testConnection();
    setStatus('Saved.');
    host.saved(next);
  } catch (e) {
    setStatus(toAppError(e).message, true);
  }
}

async function detect() {
  setStatus('Detecting fields…');
  try {
    const r = await api.detectFields();
    if (r.storyPoints) dlg().querySelector<HTMLInputElement>('#f-sp')!.value = r.storyPoints;
    if (r.sprint) dlg().querySelector<HTMLInputElement>('#f-sprint')!.value = r.sprint;
    setStatus(r.storyPoints || r.sprint ? 'Fields detected. Save to keep them.' : 'No story points or sprint field found.');
  } catch (e) {
    setStatus(toAppError(e).message, true);
  }
}

function wire() {
  const d = dlg();
  d.querySelectorAll<HTMLButtonElement>('[data-act]').forEach((b) => {
    b.onclick = (e) => {
      e.preventDefault();
      const a = b.dataset.act;
      if (a === 'close') d.close();
      else if (a === 'save') save();
      else if (a === 'test') testConnection();
      else if (a === 'diag-load') loadDiagnostics();
      else if (a === 'detect') detect();
      else if (a === 'add-env') {
        cfg = { ...cfg, server: { ...cfg.server, env: { ...readEnv().env, '': '' } } };
        keepFormAndRender();
      }
    };
  });
  d.querySelectorAll<HTMLButtonElement>('[data-env="rm"]').forEach((b) => {
    b.onclick = (e) => {
      e.preventDefault();
      b.closest('tr')!.remove();
    };
  });
  d.querySelector<HTMLSelectElement>('#s-profile')!.onchange = keepFormAndRender;
  d.querySelector<HTMLSelectElement>('#j-scope')!.onchange = (e) => {
    d.querySelector<HTMLElement>('#j-jql-row')!.hidden = (e.target as HTMLSelectElement).value !== 'jql';
  };
  d.querySelector<HTMLTextAreaElement>('#j-jql')!.oninput = (e) => {
    d.querySelector<HTMLElement>('#j-jql-warn')!.hidden = !!(e.target as HTMLTextAreaElement).value.trim();
  };
  d.querySelector('#sf')!.addEventListener('submit', (e) => e.preventDefault());
  d.querySelectorAll<HTMLInputElement>('[data-color]').forEach((inp) => {
    inp.oninput = () => {
      const c = { ...loadColors(), [inp.dataset.color as ColorKey]: inp.value.toLowerCase() };
      inp.parentElement!.querySelector('.hex')!.textContent = inp.value.toLowerCase();
      applyColors(c);
      saveColors(c);
    };
  });
  d.querySelectorAll<HTMLButtonElement>('[data-preset]').forEach((b) => {
    b.onclick = (e) => {
      e.preventDefault();
      const c = { ...PRESETS[b.dataset.preset as keyof typeof PRESETS] };
      applyColors(c);
      saveColors(c);
      d.querySelectorAll<HTMLInputElement>('[data-color]').forEach((inp) => {
        inp.value = c[inp.dataset.color as ColorKey];
        inp.parentElement!.querySelector('.hex')!.textContent = inp.value;
      });
    };
  });
}

/** Re-render while keeping what the user typed (used when the profile or env rows change). */
function keepFormAndRender() {
  const { next } = readForm();
  const env = cfg.server.env; // readForm drops empty-named rows; keep the newly added blank row
  cfg = { ...next, server: { ...next.server, env: '' in env ? { ...next.server.env, '': '' } : next.server.env } };
  render();
}

export function initSettings(h: SettingsHost) {
  host = h;
}

export async function openSettings(section?: 'diagnostics' | 'jira') {
  if (inApp()) {
    try {
      cfg = (await api.getConfig()) ?? structuredClone(DEFAULT_CONFIG);
    } catch {
      cfg = structuredClone(DEFAULT_CONFIG);
    }
  }
  render();
  const d = dlg();
  if (!d.open) d.showModal();
  if (inApp()) loadDiagnostics();
  if (section === 'diagnostics') d.querySelector('#diag')?.scrollIntoView();
  if (section === 'jira') d.querySelector<HTMLElement>('#j-scope')?.focus();
}
