#!/usr/bin/env node
// Fake Jira MCP server (stdio) for JiraPowder tests and demos. Answers like mcp-atlassian 0.23
// from src-tauri/tests/fixtures/fake-issues.json and understands only the JQL JiraPowder sends:
// openSprints(), futureSprints(), currentUser(), key in (...).
//
// It also offers jira_create_issue so tests can prove the app's guard refuses it. Every call
// to it is counted in FAKE_MCP_COUNTER (default: <tmp>/jirapowder-fake-mcp-writes).
//
// Env:
//   FAKE_MCP_ISSUES   path to an issues file (default: the fixture)
//   FAKE_MCP_LARGE=N  add N generated tickets to the active sprint (performance tests)
//   FAKE_MCP_PAGING   "token" (default, like Jira Cloud) or "offset" (like Server/DC)
//   FAKE_MCP_COUNTER  write-attempt counter file
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const here = dirname(fileURLToPath(import.meta.url));
const file = process.env.FAKE_MCP_ISSUES ?? join(here, '..', '..', 'src-tauri', 'tests', 'fixtures', 'fake-issues.json');
const data = JSON.parse(readFileSync(file, 'utf8'));
const counter = process.env.FAKE_MCP_COUNTER ?? join(tmpdir(), 'jirapowder-fake-mcp-writes');
const paging = process.env.FAKE_MCP_PAGING ?? 'token';
const SPRINT = 'customfield_10020';

if (Number(process.env.FAKE_MCP_LARGE) > 0) addGenerated(data.issues, Number(process.env.FAKE_MCP_LARGE));

/** N extra tickets in the active sprint, each blocked by up to two earlier ones. */
function addGenerated(issues, n) {
  const tmpl = issues.find((i) => i[SPRINT]?.value?.[0]?.state === 'active');
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const made = [];
  for (let i = 0; i < n; i++) {
    const key = `GEN-${i + 1}`;
    const by = made.length ? [...new Set([made[Math.floor(rnd() * made.length)], made[Math.floor(rnd() * made.length)]])] : [];
    issues.push({
      ...tmpl,
      id: String(90000 + i),
      key,
      summary: `Generated ticket ${i + 1}`,
      browse_url: `${data.site}/browse/${key}`,
      status: rnd() < 0.2 ? { name: 'Done', category: 'Done', color: 'green' } : { name: 'To Do', category: 'To Do', color: 'blue-gray' },
      issuelinks: by.map((b, j) => ({ id: `g${i}-${j}`, type: { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }, inward_issue: { id: '0', key: b } })),
    });
    if (rnd() < 0.7) made.push(key);
  }
}

const sprintState = (i) => i[SPRINT]?.value?.find?.((s) => s.state === 'active' || s.state === 'future')?.state;

function select(jql) {
  const keys = jql.match(/key\s+in\s*\(([^)]*)\)/i);
  let out;
  if (keys) {
    const want = new Set(keys[1].split(',').map((k) => k.trim()));
    out = data.issues.filter((i) => want.has(i.key));
  } else if (/openSprints\(\)/.test(jql)) out = data.issues.filter((i) => sprintState(i) === 'active');
  else if (/futureSprints\(\)/.test(jql)) out = data.issues.filter((i) => sprintState(i) === 'future');
  else throw new Error(`Error calling tool 'search': fake server does not understand JQL: ${jql}`);
  if (/assignee\s*=\s*currentUser\(\)/i.test(jql)) out = out.filter((i) => i.assignee?.account_id === data.me);
  return out;
}

function shape(issue, fields) {
  if (fields === '*all') return issue;
  const want = new Set(fields.split(',').map((f) => f.trim()));
  const map = { issuetype: 'issue_type' };
  const out = { id: issue.id, key: issue.key };
  for (const f of want) {
    const k = map[f] ?? f;
    if (k in issue) out[k] = issue[k];
  }
  if (issue.browse_url) out.browse_url = issue.browse_url;
  return out;
}

const text = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] });
const fail = (msg) => ({ content: [{ type: 'text', text: msg }], isError: true });

const server = new McpServer({ name: 'Fake Jira MCP', version: '0.1.0' });

server.registerTool(
  'jira_search',
  {
    description: 'Search Jira issues using JQL',
    inputSchema: {
      jql: z.string(),
      fields: z.string().optional(),
      limit: z.number().int().min(1).optional(),
      start_at: z.number().int().min(0).optional(),
      page_token: z.string().optional(),
    },
  },
  async ({ jql, fields = 'summary,status', limit = 10, start_at = 0, page_token }) => {
    let all;
    try {
      all = select(jql);
    } catch (e) {
      return fail(e.message);
    }
    const size = Math.min(limit, 50);
    const start = page_token ? Number(Buffer.from(page_token, 'base64').toString()) : start_at;
    const page = all.slice(start, start + size).map((i) => shape(i, fields));
    const res = { total: paging === 'token' ? -1 : all.length, start_at: start, max_results: size, issues: page };
    if (paging === 'token' && start + size < all.length) res.next_page_token = Buffer.from(String(start + size)).toString('base64');
    return text(res);
  },
);

server.registerTool(
  'jira_get_issue',
  { description: 'Get one Jira issue', inputSchema: { issue_key: z.string(), fields: z.string().optional() } },
  async ({ issue_key, fields = '*all' }) => {
    const i = data.issues.find((x) => x.key === issue_key);
    return i ? text(shape(i, fields)) : fail(`Issue ${issue_key} not found`);
  },
);

server.registerTool(
  'jira_search_fields',
  { description: 'Search Jira field definitions', inputSchema: { keyword: z.string().optional(), limit: z.number().optional() } },
  async ({ keyword = '' }) => {
    const fields = [
      { id: 'customfield_10016', name: 'Story point estimate', custom: true },
      { id: 'customfield_10020', name: 'Sprint', custom: true },
      { id: 'summary', name: 'Summary', custom: false },
    ];
    return text(fields.filter((f) => f.name.toLowerCase().includes(keyword.toLowerCase())));
  },
);

// A write tool. JiraPowder must never call it.
server.registerTool(
  'jira_create_issue',
  { description: 'Create a Jira issue (write)', inputSchema: { project_key: z.string().optional(), summary: z.string().optional() } },
  async () => {
    let n = 0;
    try {
      n = Number(readFileSync(counter, 'utf8')) || 0;
    } catch {}
    writeFileSync(counter, String(n + 1));
    return text({ created: true });
  },
);

process.stderr.write(`fake-mcp: ${data.issues.length} issues, ${paging} paging\n`);
await server.connect(new StdioServerTransport());
